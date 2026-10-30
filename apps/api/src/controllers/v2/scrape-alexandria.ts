import { z } from "zod";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import { externalRequestId } from "../../lib/external-request-id";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { billingCountryForTeam } from "../../lib/billing-country";
import { checkKeyFormatRestriction } from "../../lib/key-restriction";
import { orgIdFromAcuc } from "../../lib/team-org";
import { logProviderScrape, logRequest } from "../../services/logging/log_job";
import { markAlexandriaActivity } from "../../lib/alexandria-activity";
import {
  discoveryForCalls,
  recordDiscoveredTools,
} from "../../lib/alexandria-discovery";
import {
  callsSchema,
  callSchema,
  answerSchema,
} from "../../services/alexandria/contracts";
import {
  REQUEST_ID_PATTERN,
  retrieveProviders,
} from "../../services/alexandria/retrieve";
import type { RequestWithAuth } from "./types";

const FIND_TOOLS_LOGGED_OPTIONS = [
  "query",
  "providers",
  "categories",
  "groups",
  "capabilities",
  "level",
  "limit",
  "offset",
  "expand",
];

const isFindTools = (call: { provider?: string; capability?: string }) =>
  call.provider === "firecrawl" && call.capability === "find-tools";

const findToolsItems = (data: unknown): unknown[] => {
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
};

const agentInteropSchema = z.strictObject({
  auth: z.string(),
  requestId: z.string(),
  shouldBill: z.boolean(),
  boostConcurrency: z.boolean().optional(),
  hostedMcp: z.boolean().optional(),
});

const providerScrapeSchema = z.strictObject({
  alexandria: z.preprocess(
    value => (Array.isArray(value) ? value : [value]),
    callsSchema,
  ),
  timeout: z
    .number()
    .int()
    .positive()
    .default(120_000)
    .transform(value => Math.min(value, 120_000)),
  origin: z.string().default("api"),
  integration: z.string().nullable().optional(),
  zeroDataRetention: z.boolean().optional(),
  __agentInterop: agentInteropSchema.optional(),
});

export async function providerScrapeController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  legacy = false,
) {
  const legacyZeroDataRetention = {
    zeroDataRetention: z.boolean().optional(),
    __agentInterop: agentInteropSchema.optional(),
  };
  const legacyBody = legacy
    ? z
        .union([
          callSchema.extend(legacyZeroDataRetention),
          z.strictObject({ requests: callsSchema, ...legacyZeroDataRetention }),
        ])
        .parse(req.body)
    : null;
  const body = providerScrapeSchema.parse(
    legacyBody
      ? (({ zeroDataRetention, __agentInterop, ...rest }) => ({
          alexandria: "requests" in rest ? rest.requests : [rest],
          zeroDataRetention,
          __agentInterop,
        }))(legacyBody)
      : req.body,
  );

  if (body.__agentInterop) {
    if (!config.AGENT_INTEROP_SECRET)
      return res
        .status(403)
        .json({ success: false, error: "Agent interop is not enabled." });
    if (!isAgentInteropSecretValid(body.__agentInterop.auth))
      return res
        .status(403)
        .json({ success: false, error: "Invalid agent interop." });
  }
  const requestId = req.get("x-request-id") ?? randomUUID();
  if (REQUEST_ID_PATTERN.test(requestId))
    res.setHeader("x-request-id", requestId);

  if (req.auth.team_id.startsWith("preview_keyless_")) {
    return res.status(403).json({
      success: false,
      error: "An API key is required for provider tools.",
    });
  }

  if (!req.acuc)
    return res.status(403).json({
      success: false,
      error: "This endpoint is not enabled for this team.",
    });
  // Exchange refuses capabilities that cannot honour ZDR, per call.
  const zeroDataRetention =
    getScrapeZDR(req.acuc.flags) === "forced" ||
    body.zeroDataRetention === true;
  if (
    (req as any).agentIndexOnly ||
    ["pending", "blocked"].includes(req.acuc._agentSponsor?.status ?? "")
  )
    return res.status(403).json({
      success: false,
      code: "AGENT_INDEX_ONLY",
      error: "Verify this API key before executing provider tools.",
    });
  const restriction = await checkKeyFormatRestriction(
    ["json"],
    [],
    req.acuc.api_key_id,
    req.acuc.flags,
  );
  if (!restriction.allowed)
    return res
      .status(restriction.status)
      .json({ success: false, error: restriction.error });
  if (!config.FIRE_EXCHANGE_URL)
    return res
      .status(503)
      .json({ success: false, error: "This endpoint is not available." });

  const target = `alexandria:${body.alexandria.map(call => `${call.provider}/${call.capability}`).join(",")}`;
  const discovery =
    zeroDataRetention || body.__agentInterop
      ? Promise.resolve(null)
      : discoveryForCalls(req.auth.team_id, body.alexandria).catch(error => {
          logger.warn("Alexandria discovery lookup failed", { error });
          return null;
        });
  const startedAt = Date.now();
  let result;
  try {
    result = await retrieveProviders({
      teamId: req.auth.team_id,
      orgId: orgIdFromAcuc(req.acuc),
      apiKeyId: req.acuc.api_key_id ?? null,
      apiKeyIdText: req.acuc.api_key_id_text ?? null,
      flags: req.acuc.flags,
      calls: body.alexandria,
      resultAuthorization: req.get("authorization"),
      requestId,
      agentRequestId: body.__agentInterop?.requestId,
      hostedMcp: req.auth.hostedMcp,
      scrapeId: uuidv7(),
      timeoutMs: body.timeout,
      bypassBilling: body.__agentInterop?.shouldBill === false,
      zeroDataRetention,
      clientIp: req.ip,
      billingCountry: await billingCountryForTeam(req.auth.team_id),
      rateLimitMultiplier: req.acuc.rate_limit_multiplier,
    });
  } catch (error) {
    logger.error("Provider scrape unavailable", {
      error,
      teamId: req.auth.team_id,
    });
    return res.status(503).json({
      success: false,
      error: "Provider request unavailable. Retry with the same x-request-id.",
    });
  }
  const timeTaken = (Date.now() - startedAt) / 1000;
  markAlexandriaActivity(req.auth.team_id);
  if (result.executed && !body.__agentInterop) {
    const apiKeyId = req.acuc.api_key_id ?? null;
    const served = answerSchema.safeParse(result.body);
    const failure = result.body as {
      error?: unknown;
      creditsCost?: unknown;
    } | null;
    const successful =
      result.status === 200 &&
      served.success &&
      served.data.results.every(item => !item.error);
    const error = served.success
      ? served.data.results.find(item => item.error)?.error?.message
      : typeof failure?.error === "string"
        ? failure.error
        : undefined;
    const credits = served.success
      ? served.data.creditsCost
      : failure?.creditsCost;
    if (served.success && !zeroDataRetention)
      recordDiscoveredTools(
        req.auth.team_id,
        "find_tools",
        result.scrapeId,
        served.data.results.flatMap(item =>
          isFindTools(item)
            ? findToolsItems(item.data).flatMap(tool => {
                const { provider, capability } = (tool ?? {}) as {
                  provider?: unknown;
                  capability?: unknown;
                };
                return typeof provider === "string" &&
                  typeof capability === "string"
                  ? [{ provider, capability }]
                  : [];
              })
            : [],
        ),
      );
    // Preserve parent/child ordering without delaying the provider response.
    void (async () => {
      // Bounded so a slow Redis never holds back the activity log.
      const discovered = await Promise.race([
        discovery,
        new Promise<null>(resolve =>
          setTimeout(() => resolve(null), 500).unref(),
        ),
      ]);
      await logRequest({
        id: result.scrapeId,
        kind: "alexandria",
        api_version: "v2",
        external_request_id: externalRequestId(req),
        team_id: req.auth.team_id,
        api_key_id: apiKeyId,
        origin: body.origin,
        integration: body.integration ?? null,
        target_hint: target,
        zeroDataRetention,
        jobAccess: false,
      });
      await logProviderScrape({
        id: result.scrapeId,
        request_id: result.scrapeId,
        target,
        team_id: req.auth.team_id,
        options: {
          alexandria: body.alexandria.map(
            ({ provider, capability, options }, i) => ({
              provider,
              capability,
              ...(served.success && served.data.results[i]
                ? {
                    code: served.data.results[i].error?.code ?? null,
                    creditsCost: served.data.results[i].creditsCost ?? 0,
                  }
                : {}),
              ...(isFindTools({ provider, capability })
                ? {
                    options: {
                      ...Object.fromEntries(
                        Object.entries(options).filter(([key]) =>
                          FIND_TOOLS_LOGGED_OPTIONS.includes(key),
                        ),
                      ),
                      ...(Array.isArray(options.urls)
                        ? { urlCount: options.urls.length }
                        : {}),
                    },
                    ...(served.success
                      ? {
                          returned: findToolsItems(served.data.results[i]?.data)
                            .length,
                        }
                      : {}),
                  }
                : {}),
              ...(discovered && Object.keys(discovered[i]).length
                ? { discovery: discovered[i] }
                : {}),
            }),
          ),
        },
        time_taken: timeTaken,
        credits_cost:
          typeof credits === "number" &&
          Number.isFinite(credits) &&
          credits >= 0
            ? credits
            : 0,
        is_successful: successful,
        error: successful
          ? undefined
          : (error ?? `Provider request failed (${result.status}).`),
        zeroDataRetention,
      });
    })().catch(error =>
      logger.warn("Provider activity logging failed", {
        error,
        scrapeId: result.scrapeId,
      }),
    );
  }

  if (result.status !== 200) {
    const refused = result.body as {
      code?: unknown;
      retryAfterSeconds?: unknown;
    } | null;
    if (
      refused?.code === "index_daily_limit" &&
      typeof refused.retryAfterSeconds === "number"
    )
      res.setHeader("Retry-After", String(refused.retryAfterSeconds));
    return res.status(result.status).json(result.body);
  }
  const answer = answerSchema.parse(result.body);
  if (legacy) {
    if (legacyBody && "requests" in legacyBody) return res.json(answer);
    const first = answer.results[0];
    if (first.error) {
      const status = first.error.status ?? 502;
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false,
        code: first.error.code,
        error: first.error.message,
      });
    }
    return res.json({ success: true, ...first });
  }
  return res.json({
    success: true,
    scrape_id: result.scrapeId,
    data: { alexandria: answer.results, creditsCost: answer.creditsCost },
  });
}
