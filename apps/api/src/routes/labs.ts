import express, { Request, Response } from "express";
import { Readable } from "node:stream";
import { Agent, fetch } from "undici";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import type { RequestWithAuth } from "../controllers/v1/types";
import { RateLimiterMode } from "../types";
import { authMiddleware, wrap } from "./shared";

const TIMEOUT_MS = 120_000;

const FORWARDED_REQUEST_HEADERS = ["accept", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id"];

const dispatcher = new Agent({
  connectTimeout: TIMEOUT_MS,
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

function labsError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function upstreamBase(): string | null {
  if (!config.LABS_SEARCH_URL || !config.LABS_SEARCH_SECRET) return null;
  return config.LABS_SEARCH_URL.replace(/\/+$/, "");
}

function callerApiKey(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  return header.split(" ")[1];
}

function isMultipart(req: Request): boolean {
  const contentType = req.headers["content-type"];
  return (
    typeof contentType === "string" &&
    contentType.includes("multipart/form-data")
  );
}

function hasJsonBody(req: Request): boolean {
  return req.method !== "GET" && req.method !== "DELETE";
}

function upstreamHeaders(req: RequestWithAuth<any, any, any>) {
  const headers: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[h];
    if (typeof value === "string") headers[h] = value;
  }

  headers["x-labs-search-secret"] = config.LABS_SEARCH_SECRET!;
  headers["x-labs-search-team-id"] = req.auth.team_id;
  const apiKey = callerApiKey(req);
  if (apiKey) headers["x-labs-search-key"] = apiKey;

  if (isMultipart(req)) {
    for (const h of ["content-type", "content-length"]) {
      const value = req.headers[h];
      if (typeof value === "string") headers[h] = value;
    }
  } else if (hasJsonBody(req)) {
    headers["content-type"] = "application/json";
  }

  return headers;
}

function upstreamBody(req: RequestWithAuth<any, any, any>) {
  if (isMultipart(req)) {
    return Readable.toWeb(req) as ReadableStream;
  }
  if (!hasJsonBody(req)) return undefined;
  return JSON.stringify(req.body ?? {});
}

async function labsProxyController(req: Request, res: Response) {
  const authedReq = req as RequestWithAuth<any, any, any>;
  const logger = rootLogger.child({
    module: "api/labs",
    method: req.method,
    path: req.path,
    teamId: authedReq.auth.team_id,
  });

  const base = upstreamBase();
  if (!base) {
    return labsError(res, 503, "This endpoint is not available.");
  }

  if (!authedReq.acuc?.flags?.labsSearch) {
    return labsError(res, 403, "This endpoint is not enabled for this team.");
  }

  try {
    const upstream = await fetch(base + req.originalUrl, {
      method: req.method,
      headers: upstreamHeaders(authedReq),
      body: upstreamBody(authedReq),
      duplex: "half",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher,
    });

    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(h);
      if (value) res.setHeader(h, value);
    }

    const text = await upstream.text();
    let responseBody: any;
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = text;
    }

    if (responseBody === null || typeof responseBody === "string") {
      return res.status(upstream.status).send(responseBody ?? "");
    }
    return res.status(upstream.status).json(responseBody);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      logger.error("Labs proxy timed out");
      return labsError(res, 504, "The request timed out.");
    }
    logger.error("Labs proxy error", { error });
    return labsError(res, 502, "The request could not be completed.");
  }
}

export const labsRouter = express.Router();

labsRouter.post(
  "/search",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.post(
  "/search/data/sites",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.post(
  "/search/data/documents",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.post(
  "/search/data/pages",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.get(
  "/search/data",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.patch(
  "/search/data/:sourceId",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.delete(
  "/search/data/:sourceId",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.post(
  "/search/data/:sourceId/refresh",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.get(
  "/search/providers",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.get(
  "/search/packs",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.patch(
  "/search/packs/:packId",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.post(
  "/search/configs",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.get(
  "/search/configs",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.patch(
  "/search/configs/:id",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.delete(
  "/search/configs/:id",
  authMiddleware(RateLimiterMode.Labs),
  wrap(labsProxyController),
);

labsRouter.all(/(.*)/, (req: Request, res: Response) => {
  rootLogger.warn("Labs path is not proxied by this API", {
    module: "api/labs",
    method: req.method,
    path: req.originalUrl,
  });
  return res.status(404).json({
    success: false,
    code: "LABS_ROUTE_NOT_PROXIED",
    error:
      `${req.method} ${req.baseUrl}${req.path} is not routed by this API. The Labs Search ` +
      `service may serve it, but this proxy does not forward it yet.`,
  });
});
