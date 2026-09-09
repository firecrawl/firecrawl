import { settleExchangeCall } from "../services/exchange/settle";
import { bountyBlocklistMiddleware } from "./exchange-blocklist";
import express, { Request, Response } from "express";
import {
  ExchangeProxyError,
  exchangeProxyFailureResponse,
  exchangeUpstreamBase,
  forwardToExchange,
} from "../lib/exchange-proxy";
import { logger as rootLogger } from "../lib/logger";
import type { RequestWithAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authMiddleware, checkCreditsMiddleware, wrap } from "./shared";
import { isAgentInteropSecretValid } from "../lib/agent-interop";

const DISCOVER_TIMEOUT_MS = 10_000;
const RETRIEVE_TIMEOUT_MS = 50_000;
const ANALYTICS_TIMEOUT_MS = 20_000;
const APPLICATIONS_TIMEOUT_MS = 15_000;
const CLAIMS_TIMEOUT_MS = 20_000;
const SUPPLY_TIMEOUT_MS = 30_000;
const INGEST_TIMEOUT_MS = 50_000;

function exchangeError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function exchangeAccessError(
  req: RequestWithAuth<any, any, any>,
  requiresRetrieveFlag = true,
) {
  if (!exchangeUpstreamBase()) {
    return { status: 503, error: "This endpoint is not available." };
  }
  if (requiresRetrieveFlag && !req.acuc?.flags?.exchangeRetrieve) {
    return {
      status: 403,
      error: "This endpoint is not enabled for this team.",
    };
  }
  return null;
}

function exchangeProxy(
  timeout: number,
  options: { requiresRetrieveFlag?: boolean; billUsage?: boolean } = {},
) {
  const requiresRetrieveFlag = options.requiresRetrieveFlag !== false;

  return async function controller(req: Request, res: Response) {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const logger = rootLogger.child({
      module: "api/exchange",
      method: req.method,
      path: req.path,
      teamId: authedReq.auth.team_id,
    });

    const accessError = exchangeAccessError(authedReq, requiresRetrieveFlag);
    if (accessError) {
      return exchangeError(res, accessError.status, accessError.error);
    }

    const interop = options.billUsage ? req.body?.__agentInterop : undefined;
    if (interop !== undefined && !isAgentInteropSecretValid(interop?.auth)) {
      return exchangeError(res, 403, "Invalid agent interop.");
    }
    let body = req.body;
    if (interop !== undefined) {
      body = { ...body };
      delete body.__agentInterop;
    }

    const accept = req.headers["accept"];
    const requestId = req.headers["x-request-id"];
    try {
      const upstream = options.billUsage
        ? await settleExchangeCall({
            teamId: authedReq.auth.team_id,
            apiKeyId: authedReq.acuc?.api_key_id ?? null,
            orgId: authedReq.acuc?.org_id,
            body,
            timeoutMs: timeout,
            requestId: typeof requestId === "string" ? requestId : undefined,
            bypassBilling: interop?.shouldBill === false,
            logger,
          })
        : await forwardToExchange({
            teamId: authedReq.auth.team_id,
            method: req.method,
            path: req.originalUrl.replace(/^\/exchange/, "/v1"),
            body: req.body,
            timeoutMs: timeout,
            ...(typeof accept === "string" ? { accept } : {}),
            ...(typeof requestId === "string" ? { requestId } : {}),
          });

      if (upstream.contentType)
        res.setHeader("content-type", upstream.contentType);
      if (upstream.requestId) res.setHeader("x-request-id", upstream.requestId);

      if (upstream.body === null || typeof upstream.body === "string") {
        return res.status(upstream.status).send(upstream.body ?? "");
      }
      return res.status(upstream.status).json(upstream.body);
    } catch (error: unknown) {
      if (error instanceof ExchangeProxyError) {
        if (error.kind === "timeout") logger.error("Exchange proxy timed out");
        else logger.error("Exchange proxy error", { error: error.cause });
        const failure = exchangeProxyFailureResponse(error.kind);
        return exchangeError(res, failure.status, failure.error);
      }
      logger.error("Exchange proxy error", { error });
      return exchangeError(res, 502, "The request could not be completed.");
    }
  };
}

export const exchangeRouter = express.Router();

exchangeRouter.get(
  "/discover{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(DISCOVER_TIMEOUT_MS)),
);

exchangeRouter.post(
  "/retrieve",
  authMiddleware(RateLimiterMode.Labs),
  (req, res, next) => {
    const error = exchangeAccessError(req as RequestWithAuth<any, any, any>);
    if (error) return exchangeError(res, error.status, error.error);
    next();
  },
  checkCreditsMiddleware(1),
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS, { billUsage: true })),
);

exchangeRouter.get(
  "/analytics{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS)),
);

exchangeRouter.get(
  "/platform{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/platform{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/rates/lookup",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/rates/lookup",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/publisher/supply/key",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/publisher{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties",
  authMiddleware(RateLimiterMode.Labs),
  bountyBlocklistMiddleware,
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.put(
  "/publisher/bounties/:id",
  authMiddleware(RateLimiterMode.Labs),
  bountyBlocklistMiddleware,
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/publisher/bounties/:id",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/claim",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/submit",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/bounties/:id/skill",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(ANALYTICS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/applications",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(APPLICATIONS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/applications/:id/withdraw",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(APPLICATIONS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/claims",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims/:id/release",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/claims/:id/verify",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(CLAIMS_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/publisher/supply/key",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.get(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.put(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/supply{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(SUPPLY_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/records/fetch",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS)),
);

exchangeRouter.get(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.post(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.patch(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);

exchangeRouter.delete(
  "/ingest{/*path}",
  authMiddleware(RateLimiterMode.Labs),
  wrap(exchangeProxy(INGEST_TIMEOUT_MS, { requiresRetrieveFlag: false })),
);
