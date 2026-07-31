import type { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { logger as rootLogger } from "../../lib/logger";
import { getSearchForcedKind, getSearchZDR } from "../../lib/zdr-helpers";
import { executeExchangeCalls } from "../../services/exchange/execute";
import { logRequest } from "../../services/logging/log_job";
import { applyZdrScope } from "../../services/sentry";
import {
  exchangeInvokeRequestSchema,
  type ExchangeInvokeRequest,
  type ExchangeInvokeResponse,
  type RequestWithAuth,
} from "./types";

export async function exchangeInvokeController(
  req: RequestWithAuth<{}, ExchangeInvokeResponse, ExchangeInvokeRequest>,
  res: Response<ExchangeInvokeResponse>,
) {
  const jobId = uuidv7();
  const logger = rootLogger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "exchangeInvokeController",
  });

  try {
    req.body = exchangeInvokeRequestSchema.parse(req.body);
    const sponsor = req.acuc?._agentSponsor;
    if (sponsor?.status === "blocked") {
      return res.status(403).json({
        success: false,
        error: "This API key has been blocked by the account holder.",
      });
    }
    if (sponsor?.status === "pending") {
      return res.status(403).json({
        success: false,
        error:
          "Exchange is unavailable until this agent API key is verified by its sponsor.",
      });
    }

    const forcedKind = getSearchForcedKind(req.acuc?.flags);
    const requestedZdr = req.body.zeroDataRetention || forcedKind !== null;
    applyZdrScope(requestedZdr);
    if (
      req.body.zeroDataRetention &&
      forcedKind === null &&
      getSearchZDR(req.acuc?.flags) !== "allowed"
    ) {
      return res.status(403).json({
        success: false,
        error:
          "Zero Data Retention is not enabled for this team. Contact support@firecrawl.com to enable it.",
      });
    }

    await logRequest({
      id: jobId,
      kind: "search",
      api_version: "v2",
      team_id: req.auth.team_id,
      origin: req.body.origin,
      target_hint: req.body.calls
        .map(call => `${call.provider}/${call.capability}`)
        .join(","),
      zeroDataRetention: requestedZdr,
      api_key_id: req.acuc?.api_key_id ?? null,
    });

    const execution = await executeExchangeCalls({
      agentIndexOnly: Boolean((req as any).agentIndexOnly),
      apiKeyId: req.acuc?.api_key_id ?? null,
      billing: { endpoint: "exchange", jobId },
      calls: req.body.calls,
      logger,
      shouldBill: true,
      teamId: req.auth.team_id,
      timeoutMs: req.body.timeout,
      zeroDataRetention: requestedZdr,
    });
    const successful = execution.results.filter(result => !result.error).length;
    if (successful === 0) {
      const firstError = execution.results.find(result => result.error)?.error;
      const status =
        firstError?.status &&
        firstError.status >= 400 &&
        firstError.status < 600
          ? firstError.status
          : 502;
      return res.status(status).json({
        success: false,
        error: firstError?.message ?? "All Exchange calls failed.",
        details: {
          exchange: execution.results,
          creditsUsed: execution.billedCredits,
          id: jobId,
        },
      });
    }

    return res.status(200).json({
      success: true,
      partial: successful !== execution.results.length,
      data: { exchange: execution.results },
      creditsUsed: execution.billedCredits,
      id: jobId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
      });
    }
    logger.error("Unhandled Exchange invocation error", { error });
    return res.status(500).json({
      success: false,
      error: "Exchange invocation failed.",
    });
  }
}
