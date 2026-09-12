import { z } from "zod";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import { externalRequestId } from "../../lib/external-request-id";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { checkKeyFormatRestriction } from "../../lib/key-restriction";
import { logRequest } from "../../services/logging/log_job";
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

const providerScrapeSchema = z.strictObject({
  exchange: z.preprocess(
    value => (Array.isArray(value) ? value : [value]),
    callsSchema,
  ),
  timeout: z
    .number()
    .int()
    .positive()
    .default(50000)
    .transform(value => Math.min(value, 50000)),
  origin: z.string().default("api"),
  integration: z.string().nullable().optional(),
  __agentInterop: z
    .strictObject({
      auth: z.string(),
      requestId: z.string(),
      shouldBill: z.boolean(),
      boostConcurrency: z.boolean().optional(),
    })
    .optional(),
});

// `/v2/scrape` with an `exchange` body, and the legacy `/exchange/retrieve`
// route. Both are mounted through wrap(), which formats Zod errors.
export async function providerScrapeController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  legacy = false,
) {
  const legacyBody = legacy
    ? z
        .union([callSchema, z.strictObject({ requests: callsSchema })])
        .parse(req.body)
    : null;
  const body = providerScrapeSchema.parse(
    legacyBody
      ? {
          exchange:
            "requests" in legacyBody ? legacyBody.requests : [legacyBody],
        }
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
  const requestId =
    body.__agentInterop?.requestId ?? req.get("x-request-id") ?? randomUUID();
  if (REQUEST_ID_PATTERN.test(requestId))
    res.setHeader("x-request-id", requestId);

  if (!req.acuc?.flags?.exchangeRetrieve)
    return res.status(403).json({
      success: false,
      error: "This endpoint is not enabled for this team.",
    });
  if (getScrapeZDR(req.acuc.flags) === "forced")
    return res.status(403).json({
      success: false,
      error: "Provider tools do not support zero data retention.",
    });
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

  let result;
  try {
    result = await retrieveProviders({
      teamId: req.auth.team_id,
      apiKeyId: req.acuc.api_key_id ?? null,
      flags: req.acuc.flags,
      calls: body.exchange,
      requestId,
      scrapeId: randomUUID(),
      timeoutMs: body.timeout,
      bypassBilling: body.__agentInterop?.shouldBill === false,
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

  // One requests row per provider execution, not per refusal or replay.
  if (result.executed && !body.__agentInterop)
    void logRequest({
      id: result.scrapeId,
      kind: "scrape",
      api_version: "v2",
      external_request_id: externalRequestId(req),
      team_id: req.auth.team_id,
      api_key_id: req.acuc.api_key_id ?? null,
      origin: body.origin,
      integration: body.integration ?? null,
      target_hint: `exchange:${body.exchange.map(call => `${call.provider}/${call.capability}`).join(",")}`,
      zeroDataRetention: false,
    }).catch(error =>
      logger.warn("Provider request logging failed", {
        error,
        scrapeId: result.scrapeId,
      }),
    );

  if (result.status !== 200) return res.status(result.status).json(result.body);
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
    data: { exchange: answer.results, creditsCost: answer.creditsCost },
  });
}
