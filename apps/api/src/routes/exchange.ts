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
import { authMiddleware, wrap } from "./shared";

const DISCOVER_TIMEOUT_MS = 10_000;
const RETRIEVE_TIMEOUT_MS = 50_000;
const ANALYTICS_TIMEOUT_MS = 20_000;
const APPLICATIONS_TIMEOUT_MS = 15_000;
const CLAIMS_TIMEOUT_MS = 20_000;
const SUPPLY_TIMEOUT_MS = 30_000;

function exchangeError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function exchangeProxy(
  timeout: number,
  options: { requiresRetrieveFlag?: boolean } = {},
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

    if (!exchangeUpstreamBase()) {
      return exchangeError(res, 503, "This endpoint is not available.");
    }

    if (requiresRetrieveFlag && !authedReq.acuc?.flags?.exchangeRetrieve) {
      return exchangeError(
        res,
        403,
        "This endpoint is not enabled for this team.",
      );
    }

    const accept = req.headers["accept"];
    const requestId = req.headers["x-request-id"];
    try {
      const upstream = await forwardToExchange({
        teamId: authedReq.auth.team_id,
        method: req.method === "GET" ? "GET" : "POST",
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
  wrap(exchangeProxy(RETRIEVE_TIMEOUT_MS)),
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
