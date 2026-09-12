import { z } from "zod";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { isAgentInteropSecretValid } from "../../lib/agent-interop";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import {
  checkKeyEndpointRestriction,
  checkKeyFormatRestriction,
} from "../../lib/key-restriction";
import { logRequest } from "../../services/logging/log_job";
import {
  callsSchema,
  callSchema,
  answerSchema,
} from "../../services/alexandria/contracts";
import { retrieveProviders } from "../../services/alexandria/retrieve";
import type { RequestWithAuth } from "./types";

export const providerScrapeSchema = z.strictObject({
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
    })
    .optional(),
});

export async function providerScrapeController(
  req: RequestWithAuth<any, any, any>,
  res: Response,
  legacy = false,
) {
  try {
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
    const requestId =
      req.get("x-request-id") ?? body.__agentInterop?.requestId ?? randomUUID();
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
      res.setHeader("x-request-id", requestId);
    if (!req.acuc?.flags?.exchangeRetrieve)
      return res.status(403).json({
        success: false,
        error: "Provider tools are not enabled for this team.",
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
        error: "Verify this API key before executing provider tools.",
      });
    if (
      body.__agentInterop &&
      !isAgentInteropSecretValid(body.__agentInterop.auth)
    )
      return res
        .status(403)
        .json({ success: false, error: "Invalid agent interop." });
    const endpoint = await checkKeyEndpointRestriction(
      "/v2/scrape",
      req.acuc.api_key_id,
      req.acuc.flags,
    );
    if (!endpoint.allowed)
      return res
        .status(endpoint.status)
        .json({ success: false, error: endpoint.error });
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
        .json({ success: false, error: "Provider tools are not configured." });
    const jobId = randomUUID();
    if (!body.__agentInterop)
      void logRequest({
        id: jobId,
        kind: "scrape",
        api_version: "v2",
        external_request_id: requestId,
        team_id: req.auth.team_id,
        api_key_id: req.acuc.api_key_id ?? null,
        origin: body.origin,
        integration: body.integration ?? null,
        target_hint: `exchange:${body.exchange.map(call => `${call.provider}/${call.capability}`).join(",")}`,
        zeroDataRetention: false,
      }).catch(error =>
        logger.warn("Provider request logging failed", { error, jobId }),
      );
    const result = await retrieveProviders({
      teamId: req.auth.team_id,
      orgId: req.acuc.org_id,
      apiKeyId: req.acuc.api_key_id ?? null,
      calls: body.exchange,
      requestId,
      timeoutMs: body.timeout,
      bypassBilling: body.__agentInterop?.shouldBill === false,
    });
    if (result.status !== 200)
      return res.status(result.status).json(result.body);
    const answer = answerSchema.parse(result.body);
    if (legacy)
      return res.json(
        legacyBody && "requests" in legacyBody
          ? answer
          : { success: true, ...answer.results[0] },
      );
    return res.json({
      success: true,
      scrape_id: jobId,
      data: { exchange: answer.results, creditsCost: answer.creditsCost },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return res.status(400).json({ success: false, error: error.message });
    logger.error("Provider scrape unavailable", {
      error,
      teamId: req.auth.team_id,
    });
    return res.status(503).json({
      success: false,
      error: "Provider request unavailable. Retry with the same x-request-id.",
    });
  }
}
