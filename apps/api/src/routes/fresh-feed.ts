import compression from "compression";
import express, { NextFunction, Request, Response } from "express";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { request, type Dispatcher } from "undici";
import { v7 as uuidv7 } from "uuid";
import type { RequestWithAuth } from "../controllers/v1/types";
import { externalRequestId } from "../lib/external-request-id";
import {
  getRoutePattern,
  httpRequestDurationSeconds,
} from "../lib/http-metrics";
import { logger as rootLogger } from "../lib/logger";
import { requestOrigin } from "../lib/request-origin";
import { getEffectiveSearchForcedKind } from "../lib/safe-mode";
import { billTeam } from "../services/billing/credit_billing";
import { logRequest } from "../services/logging/log_job";
import { resolveIntegration } from "../utils/integration";
import { checkCreditsMiddleware, wrap } from "./shared";

const TIMEOUT_MS = 30_000;
const UPSTREAM_PATH = "/fresh-vertical-feed/local/latest";
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "vary",
];

const DECODERS: Record<string, (body: Buffer) => Promise<Buffer>> = {
  identity: async body => body,
  gzip: promisify(zlib.gunzip),
  "x-gzip": promisify(zlib.gunzip),
  deflate: promisify(zlib.inflate),
  br: promisify(zlib.brotliDecompress),
  ...(zlib.zstdDecompress ? { zstd: promisify(zlib.zstdDecompress) } : {}),
};

function creditsPerRecord(req: Request): number {
  const rate = (req as RequestWithAuth<any, any, any>).acuc?.flags
    ?.freshFeedCreditsPerRecord;
  return typeof rate === "number" && Number.isSafeInteger(rate) && rate > 0
    ? rate
    : 0;
}

async function countRecords(
  chunks: Buffer[],
  contentEncoding: string | string[] | undefined,
): Promise<number> {
  let body: Buffer = Buffer.concat(chunks);
  const encodings = String(contentEncoding ?? "identity")
    .split(",")
    .map(encoding => encoding.trim().toLowerCase())
    .reverse();
  for (const encoding of encodings) {
    const decode = DECODERS[encoding];
    if (!decode) throw new Error(`Unsupported content-encoding: ${encoding}`);
    body = await decode(body);
  }
  let page: any;
  try {
    page = JSON.parse(body.toString());
  } catch {
    throw new Error("The page is not valid JSON");
  }
  if (!Array.isArray(page?.events))
    throw new Error("The page has no events array");
  return page.events.length;
}

function freshFeedError(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function requireFreshFeedFlag(req: Request, res: Response, next: NextFunction) {
  if ((req as RequestWithAuth<any, any, any>).acuc?.flags?.freshFeed !== true) {
    return freshFeedError(
      res,
      403,
      "This endpoint is not enabled for this team.",
    );
  }
  next();
}

function requireFreshFeedCredits(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const rate = creditsPerRecord(req);
  if (rate === 0) return next();
  return checkCreditsMiddleware(rate)(
    req as RequestWithAuth<any, any, any>,
    res,
    next,
  );
}

function rejectHead(_req: Request, res: Response) {
  res.status(405).set("Allow", "GET").end();
}

function freshFeedController(upstreamBase: string, timeoutMs: number) {
  return async (req: Request, res: Response) => {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const zeroDataRetention =
      getEffectiveSearchForcedKind(authedReq.acuc?.flags, undefined) !== null;

    const started: number = (req as any).requestTiming?.startTime ?? Date.now();
    const jobId = uuidv7();
    const logger = rootLogger.child({
      module: "api/fresh-feed",
      jobId,
      teamId: authedReq.auth.team_id,
      zeroDataRetention,
    });

    const queryStart = req.originalUrl.indexOf("?");
    const target =
      UPSTREAM_PATH +
      (queryStart === -1 ? "" : req.originalUrl.slice(queryStart));

    const callerGone = new AbortController();
    res.on("close", () => callerGone.abort());

    await logRequest({
      id: jobId,
      kind: "fresh_feed",
      api_version: "v2",
      external_request_id: externalRequestId(authedReq),
      team_id: authedReq.auth.team_id,
      origin: requestOrigin({}, req),
      integration: resolveIntegration(undefined, req) ?? null,
      target_hint: target,
      zeroDataRetention,
      api_key_id: authedReq.acuc?.api_key_id ?? null,
    });

    let upstream: Dispatcher.ResponseData;
    try {
      // fetch always decodes the body; request hands back the feed's bytes as sent.
      upstream = await request(upstreamBase + target, {
        headers: { "accept-encoding": req.headers["accept-encoding"] },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        signal: callerGone.signal,
      });
    } catch (error: unknown) {
      if (callerGone.signal.aborted) return;
      if ((error as { code?: unknown })?.code === "UND_ERR_HEADERS_TIMEOUT") {
        logger.error("Fresh feed timed out");
        return freshFeedError(res, 504, "The request timed out.");
      }
      logger.error("Fresh feed proxy error", { error });
      return freshFeedError(res, 502, "The request could not be completed.");
    }

    if (![200, 400, 406].includes(upstream.statusCode)) {
      upstream.body.dump().catch(() => {});
      logger.error("Fresh feed upstream error", {
        status: upstream.statusCode,
        seconds: (Date.now() - started) / 1000,
      });
      if (upstream.statusCode === 500 || upstream.statusCode === 503) {
        res.setHeader("Retry-After", "5");
        return freshFeedError(
          res,
          503,
          "The feed is temporarily unavailable. Retry the same request.",
        );
      }
      return freshFeedError(res, 502, "The request could not be completed.");
    }

    res.status(upstream.statusCode);
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers[h];
      if (value) res.setHeader(h, value);
    }

    const rate = upstream.statusCode === 200 ? creditsPerRecord(req) : 0;
    const chunks: Buffer[] = [];
    let bytes = 0;
    upstream.body.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (rate > 0) chunks.push(chunk);
    });
    const outcome = () => ({
      status: upstream.statusCode,
      contentEncoding: upstream.headers["content-encoding"],
      bytes,
      seconds: (Date.now() - started) / 1000,
    });

    let delivered = false;
    try {
      await pipeline(upstream.body, res);
      delivered = true;
    } catch (error: unknown) {
      logger.warn("Fresh feed stream failed", { error, ...outcome() });
    }
    httpRequestDurationSeconds
      .labels("v2", req.method, getRoutePattern(req), String(res.statusCode))
      .observe((Date.now() - started) / 1000);
    if (!delivered) return;

    let records: number | undefined;
    let credits = 0;
    if (rate > 0) {
      try {
        records = await countRecords(
          chunks,
          upstream.headers["content-encoding"],
        );
        credits = records * rate;
      } catch (error: unknown) {
        logger.error("Fresh feed page could not be counted for billing", {
          reason: error instanceof Error ? error.message : "unknown",
          ...outcome(),
        });
      }
    }
    if (credits > 0) {
      billTeam(
        authedReq.auth.team_id,
        authedReq.acuc?.org_id ?? null,
        credits,
        authedReq.acuc?.api_key_id ?? null,
        {
          endpoint: "fresh_feed",
          jobId,
          chargeId: jobId,
          externalRequestId: externalRequestId(authedReq),
        },
        logger,
      ).catch(error => {
        logger.error("Failed to bill fresh feed request", { error, credits });
      });
    }
    logger.info("Fresh feed request", { ...outcome(), records, credits });
  };
}

export function createFreshFeedRouter(
  upstreamUrl: string,
  timeoutMs = TIMEOUT_MS,
) {
  const router = express.Router();
  router.head("/local/latest", rejectHead);
  router.get(
    "/local/latest",
    requireFreshFeedFlag,
    requireFreshFeedCredits,
    compression(),
    wrap(freshFeedController(upstreamUrl.replace(/\/+$/, ""), timeoutMs)),
  );
  return router;
}
