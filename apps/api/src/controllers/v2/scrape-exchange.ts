import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import {
  EXCHANGE_RETRIEVE_TIMEOUT_MS,
  ExchangeProxyError,
  exchangeProxyFailureResponse,
  forwardToExchange,
} from "../../lib/exchange-proxy";
import { logRequest } from "../../services/logging/log_job";
import { externalRequestId } from "../../lib/external-request-id";
import {
  exchangeScrapeRequestSchema,
  type ExchangeScrapeResult,
  type RequestWithAuth,
  type ScrapeResponse,
} from "./types";

const retrieveBatchSchema = z
  .object({
    success: z.literal(true),
    creditsCost: z.number().int().nonnegative(),
    results: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export async function exchangeScrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, unknown>,
  res: Response<ScrapeResponse>,
  jobId: string,
) {
  const logger = _logger.child({
    method: "exchangeScrapeController",
    jobId,
    teamId: req.auth.team_id,
  });

  const parsed = exchangeScrapeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: `Bad Request: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }
  const body = parsed.data;

  if (!req.acuc?.flags?.exchangeRetrieve) {
    return res.status(403).json({
      success: false,
      error: "This endpoint is not enabled for this team.",
    });
  }
  if (!config.FIRE_EXCHANGE_URL) {
    return res.status(503).json({
      success: false,
      error: "This endpoint is not available.",
    });
  }

  void logRequest({
    id: jobId,
    kind: "scrape",
    api_version: "v2",
    external_request_id: externalRequestId(req),
    team_id: req.auth.team_id,
    origin: body.origin ?? "api",
    integration: body.integration,
    target_hint: `exchange:${body.exchange.map(e => `${e.provider}/${e.capability}`).join(",")}`,
    zeroDataRetention: false,
    api_key_id: req.acuc?.api_key_id ?? null,
  }).catch(err =>
    logger.warn("Background request log failed", { error: err, jobId }),
  );

  const timeoutMs = Math.min(
    body.timeout ?? EXCHANGE_RETRIEVE_TIMEOUT_MS,
    EXCHANGE_RETRIEVE_TIMEOUT_MS,
  );

  try {
    const upstream = await forwardToExchange({
      teamId: req.auth.team_id,
      method: "POST",
      path: "/v1/retrieve",
      body: { requests: body.exchange },
      timeoutMs,
      requestId: jobId,
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      const detail =
        typeof upstream.body === "object" && upstream.body !== null
          ? (upstream.body as { error?: unknown; code?: unknown })
          : {};
      return res.status(upstream.status).json({
        success: false,
        error:
          typeof detail.error === "string"
            ? detail.error
            : "The Exchange could not complete the request.",
        ...(typeof detail.code === "string"
          ? { code: detail.code as any }
          : {}),
      });
    }

    const answer = retrieveBatchSchema.safeParse(upstream.body);
    if (!answer.success) {
      logger.error("Exchange retrieve answered in an unknown shape", {
        status: upstream.status,
      });
      return res.status(502).json({
        success: false,
        error: "The request could not be completed.",
      });
    }

    return res.status(200).json({
      success: true,
      scrape_id: jobId,
      data: {
        exchange: answer.data.results as ExchangeScrapeResult[],
        creditsCost: answer.data.creditsCost,
      },
    });
  } catch (error: unknown) {
    if (error instanceof ExchangeProxyError) {
      logger.error("Exchange scrape proxy failed", { kind: error.kind });
      const failure = exchangeProxyFailureResponse(error.kind);
      return res
        .status(failure.status)
        .json({ success: false, error: failure.error });
    }
    logger.error("Exchange scrape failed", { error });
    const failure = exchangeProxyFailureResponse("unreachable");
    return res
      .status(failure.status)
      .json({ success: false, error: failure.error });
  }
}
