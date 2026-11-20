import { z } from "zod";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
import { keylessProviderToolsBody } from "../../lib/keyless";
import { externalRequestId } from "../../lib/external-request-id";
import { isAlexandriaZDRForced } from "../../lib/zdr-helpers";
import { timingSafeSecretEqual } from "../../lib/secret-compare";
import { billingCountryForTeam } from "../../lib/billing-country";
import { checkKeyFormatRestriction } from "../../lib/key-restriction";
import { orgIdFromAcuc } from "../../lib/team-org";
import { issueFeedbackToken } from "../../lib/alexandria-feedback-token";
import {
  alexandriaFeedbackHintApplies,
  alexandriaFeedbackNextStep,
} from "../../lib/alexandria-feedback-hint";
import { logProviderScrape, logRequest } from "../../services/logging/log_job";
import {
  markAlexandriaActivity,
  markAlexandriaCalls,
} from "../../lib/alexandria-activity";
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
  exchangeRequestId,
  retrieveProviders,
} from "../../services/alexandria/retrieve";
import { capabilityOptionTypes } from "../../services/alexandria/option-types";
import {
  AlexandriaQueryError,
  checkAlexandriaQuery,
  convertAlexandriaOptions,
  parseAlexandriaQuery,
} from "../../lib/alexandria-query";
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
  maxCredits: z.number().int().nonnegative().safe().optional(),
  __agentInterop: agentInteropSchema.optional(),
});

/**
 * GET /v2/alexandria/:provider/*capability: the whole call in the URL, the capability in the
 * path and its options in the query string (see lib/alexandria-query). Builds the
 * POST /v2/alexandria body so the rest of the chain answers it exactly as that route does.
 * Query keys are matched against the capability's contract before dot notation applies, so the
 * contract is looked up first; nothing runs when it cannot be read. The timeout can also be the
 * x-timeout-ms header, for a capability that declares its own `timeout` option.
 */
export async function alexandriaQueryBody(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  res.setHeader("Cache-Control", "no-store");
  const { auth, acuc } = req as RequestWithAuth<any, any, any>;
  const provider = String(req.params.provider);
  const capability = ([] as string[]).concat(req.params.capability).join("/");
  const query = req.query as Record<string, unknown>;
  const refuse = (error: string) =>
    res.status(400).json({ success: false, error });
  try {
    checkAlexandriaQuery(query);
  } catch (error) {
    if (error instanceof AlexandriaQueryError) return refuse(error.message);
    throw error;
  }
  if (acuc && isAlexandriaZDRForced(acuc.flags))
    return refuse(
      "This team uses zero data retention. Use POST /v2/alexandria.",
    );

  let types = new Map<string, string>();
  if (acuc && !auth.team_id.startsWith("preview_keyless_")) {
    try {
      types = await capabilityOptionTypes({
        teamId: auth.team_id,
        provider,
        capability,
        connectors: acuc.flags?.exchangeRetrieve === true,
        timeoutMs: 5_000,
      });
    } catch (error) {
      logger.warn("Alexandria contract lookup failed", { error });
      return res.status(503).json({
        success: false,
        error:
          "Provider contract lookup unavailable. No provider was executed. Retry, or use POST /v2/alexandria.",
      });
    }
  }

  let parsed: ReturnType<typeof parseAlexandriaQuery>;
  let options: Record<string, unknown>;
  try {
    parsed = parseAlexandriaQuery(query, new Set(types.keys()));
    options = convertAlexandriaOptions(parsed.options, types);
  } catch (error) {
    if (error instanceof AlexandriaQueryError) return refuse(error.message);
    throw error;
  }
  const header = req.get("x-timeout-ms");
  if (header !== undefined && parsed.timeout !== undefined)
    return refuse("Give the timeout once: in the query or in x-timeout-ms.");
  const timeout = header ?? parsed.timeout;
  if (timeout !== undefined && !/^[1-9]\d{0,8}$/.test(timeout))
    return refuse(
      "The timeout must be a whole number of milliseconds greater than 0.",
    );
  req.body = {
    provider,
    capability,
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    options,
    ...(timeout === undefined ? {} : { timeout: Number(timeout) }),
  };
  next();
}

export async function providerScrapeController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  legacy = false,
) {
  // A provider answer is for this caller and call only.
  res.setHeader("Cache-Control", "no-store");
  const legacyZeroDataRetention = {
    zeroDataRetention: z.boolean().optional(),
    timeout: z.number().int().positive().optional(),
    integration: z.string().nullable().optional(),
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
      ? (({
          zeroDataRetention,
          timeout,
          integration,
          __agentInterop,
          ...rest
        }) => ({
          alexandria: "requests" in rest ? rest.requests : [rest],
          zeroDataRetention,
          timeout,
          integration,
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
  // Trusted internal marker for zero-priced provider lines: honoured only with
  // the proxy secret and never for `fco_` tokens, otherwise ignored.
  const token = req.get("authorization")?.split(" ")[1];
  const ultrasearch =
    req.get("x-firecrawl-ultrasearch") === "true" &&
    !!token &&
    !token.startsWith("fco_") &&
    timingSafeSecretEqual(
      req.get("x-firecrawl-keyless-secret"),
      config.KEYLESS_PROXY_SECRET,
    );
  const requestId = req.get("x-request-id") ?? randomUUID();
  if (REQUEST_ID_PATTERN.test(requestId))
    res.setHeader("x-request-id", requestId);

  if (req.auth.team_id.startsWith("preview_keyless_")) {
    applyAgentAuthDiscoveryHeader(res);
    return res
      .status(403)
      .json(keylessProviderToolsBody(req.auth.team_id, req));
  }

  if (!req.acuc)
    return res.status(403).json({
      success: false,
      error: "This endpoint is not enabled for this team.",
    });
  // Exchange refuses capabilities that cannot honour ZDR, per call.
  const zeroDataRetention =
    isAlexandriaZDRForced(req.acuc.flags) || body.zeroDataRetention === true;
  if (
    (req as any).agentIndexOnly ||
    ["pending", "blocked"].includes(req.acuc._agentSponsor?.status ?? "")
  )
    return res.status(403).json({
      success: false,
      code: "AGENT_INDEX_ONLY",
      error: "Verify this API key before executing provider tools.",
    });
  const restriction = await checkKeyFormatRestriction(["json"], [], req.acuc);
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
  // The origin as the caller named it: the schema default would label every caller "api".
  const sentOrigin = (req.body as { origin?: unknown } | null)?.origin;
  const clientOrigin =
    typeof sentOrigin === "string" ? sentOrigin : req.get("x-origin");
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
      ...(body.maxCredits === undefined ? {} : { maxCredits: body.maxCredits }),
      ...(ultrasearch ? { ultrasearch } : {}),
      ...(clientOrigin ? { clientOrigin } : {}),
      ...(body.integration ? { clientIntegration: body.integration } : {}),
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
  const usageRequestId = exchangeRequestId(req.auth.team_id, requestId);
  if (result.executed && !zeroDataRetention)
    markAlexandriaCalls(
      req.auth.team_id,
      body.alexandria.map(({ provider, capability }) => ({
        requestId: usageRequestId,
        provider,
        capability,
      })),
    );
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
          ...(ultrasearch ? { ultrasearch } : {}),
          alexandria: body.alexandria.map(
            ({ provider, capability, options }, i) => ({
              provider,
              capability,
              ...(served.success && served.data.results[i]
                ? {
                    code: served.data.results[i].error?.code ?? null,
                    creditsCost: served.data.results[i].creditsCost ?? 0,
                    ...(served.data.results[i].provenance
                      ? { provenance: served.data.results[i].provenance }
                      : {}),
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
      (refused?.code === "index_daily_limit" ||
        refused?.code === "index_rate_limit") &&
      typeof refused.retryAfterSeconds === "number"
    )
      res.setHeader("Retry-After", String(refused.retryAfterSeconds));
    return res.status(result.status).json(result.body);
  }
  const exchangeAnswer = answerSchema.parse(result.body);
  const parsed = {
    ...exchangeAnswer,
    results: exchangeAnswer.results.map(
      ({ provenance: _provenance, ...item }) => item,
    ),
  };
  // One next step per response, on the first provider answer. Teams that
  // cannot send feedback get none.
  const hinted = alexandriaFeedbackHintApplies(req.auth.team_id, req.acuc.flags)
    ? parsed.results.findIndex(
        item => !item.error && item.provider !== "firecrawl",
      )
    : -1;
  const answer = zeroDataRetention
    ? parsed
    : {
        ...parsed,
        results: parsed.results.map((item, i) => {
          const provider = item.provider ?? body.alexandria[i]?.provider;
          const capability = item.capability ?? body.alexandria[i]?.capability;
          const feedbackToken =
            provider && capability
              ? issueFeedbackToken({
                  requestId: usageRequestId,
                  teamId: req.auth.team_id,
                  provider,
                  capability,
                })
              : undefined;
          const feedbackStep =
            i === hinted
              ? alexandriaFeedbackNextStep(body.origin, body.integration)
              : undefined;
          if (!feedbackStep)
            return { ...item, ...(feedbackToken ? { feedbackToken } : {}) };
          // A next step Exchange sent joins the feedback step: the feedback
          // keys stay first and keep their values, Exchange's keys follow.
          const { nextStep: exchangeStep, ...rest } = item;
          return {
            ...rest,
            ...(feedbackToken ? { feedbackToken } : {}),
            nextStep: {
              ...feedbackStep,
              ...(exchangeStep &&
              typeof exchangeStep === "object" &&
              !Array.isArray(exchangeStep)
                ? exchangeStep
                : {}),
              ...feedbackStep,
            },
          };
        }),
      };
  if (legacy) {
    if (legacyBody && "requests" in legacyBody) return res.json(answer);
    const first = answer.results[0];
    if (first.error) {
      const status = first.error.status ?? 502;
      return res.status(status >= 400 && status <= 599 ? status : 502).json({
        success: false,
        code: first.error.code,
        error: first.error.message,
        ...(first.feedbackToken ? { feedbackToken: first.feedbackToken } : {}),
        ...("nextStep" in first && first.nextStep
          ? { nextStep: first.nextStep }
          : {}),
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
