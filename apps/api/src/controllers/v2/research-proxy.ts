import { NextFunction, Request, Response } from "express";
import { Agent, fetch } from "undici";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { RequestWithMaybeACUC } from "../v1/types";

const TIMEOUT_MS = 120_000;

const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "x-request-id"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id"];

const dispatcher = new Agent({
  connectTimeout: TIMEOUT_MS,
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

export function researchFlagMiddleware(
  req: RequestWithMaybeACUC<any, any, any>,
  res: Response,
  next: NextFunction,
) {
  if (!req.acuc?.flags?.researchBeta) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  next();
}

export async function researchProxyController(
  req: Request,
  res: Response,
): Promise<void> {
  const base = config.RESEARCH_PROXY_URL;
  if (!base) {
    res.status(404).end();
    return;
  }

  const subPath = req.path.replace(/^\/research/, "") || "/";
  const url = new URL(base.replace(/\/+$/, "") + subPath);
  for (const [k, v] of Object.entries(req.query)) {
    if (Array.isArray(v)) {
      v.forEach(vv => url.searchParams.append(k, String(vv)));
    } else if (v !== undefined && v !== null) {
      url.searchParams.append(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  for (const h of FORWARDED_REQUEST_HEADERS) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }

  const init: Parameters<typeof fetch>[1] = {
    method: req.method,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    dispatcher,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    if (
      req.body &&
      typeof req.body === "object" &&
      Object.keys(req.body).length > 0
    ) {
      init.body = JSON.stringify(req.body);
      headers["content-type"] = "application/json";
    }
  }

  try {
    const upstream = await fetch(url, init);
    res.status(upstream.status);
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      res.status(504).end();
      return;
    }
    logger.error("Research proxy error", { error: err });
    res.status(502).end();
  }
}
