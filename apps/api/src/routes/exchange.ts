import express, { Request, Response } from "express";
import { Agent, fetch } from "undici";
import { config } from "../config";
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

const FORWARDED_REQUEST_HEADERS = ["accept", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id"];

function dispatcherFor(timeout: number) {
  return new Agent({
    connectTimeout: timeout,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
}

function exchangeError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function upstreamBase(): string | null {
  if (!config.FIRE_EXCHANGE_URL) return null;
  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

function exchangeProxy(
  timeout: number,
  options: { requiresRetrieveFlag?: boolean } = {},
) {
  const requiresRetrieveFlag = options.requiresRetrieveFlag !== false;
  const dispatcher = dispatcherFor(timeout);

  return async function controller(req: Request, res: Response) {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const logger = rootLogger.child({
      module: "api/exchange",
      method: req.method,
      path: req.path,
      teamId: authedReq.auth.team_id,
    });

    const base = upstreamBase();
    if (!base) {
      return exchangeError(res, 503, "This endpoint is not available.");
    }

    if (requiresRetrieveFlag && !authedReq.acuc?.flags?.exchangeRetrieve) {
      return exchangeError(
        res,
        403,
        "This endpoint is not enabled for this team.",
      );
    }

    const hasBody = req.method !== "GET";
    const path = req.originalUrl.replace(/^\/exchange/, "/v1");

    try {
      const upstream = await fetch(base + path, {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            FORWARDED_REQUEST_HEADERS.flatMap(h => {
              const value = req.headers[h];
              return typeof value === "string" ? [[h, value]] : [];
            }),
          ),
          ...(hasBody ? { "content-type": "application/json" } : {}),
          "x-exchange-team-id": authedReq.auth.team_id,
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeout),
        dispatcher,
      });

      for (const h of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(h);
        if (value) res.setHeader(h, value);
      }

      const text = await upstream.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }

      if (body === null || typeof body === "string") {
        return res.status(upstream.status).send(body ?? "");
      }
      return res.status(upstream.status).json(body);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        logger.error("Exchange proxy timed out");
        return exchangeError(res, 504, "The request timed out.");
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
