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
  FRESH_FEED_COLLECTION_HEADER,
  freshFeedUpstreamPath,
  isFreshFeedUpstream,
  isValidFreshFeedCollection,
  normalizeFreshFeedUpstreams,
  resolveFreshFeedVertical,
  type FreshFeedUpstream,
  type FreshFeedUpstreamUrls,
} from "../lib/fresh-feed";
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
const RESOLVED_TARGET = Symbol("freshFeedResolvedTarget");
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "vary",
];

type FreshFeedRouteSpec =
  | { kind: "local" }
  | { kind: "curated" }
  | { kind: "vertical" };

interface ResolvedFreshFeedTarget {
  upstream: FreshFeedUpstream;
  upstreamBase: string;
  target: string;
  collection?: string;
}

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

function rejectVerticalHead(req: Request, res: Response) {
  const vertical = req.params.vertical;
  if (
    typeof vertical === "string" &&
    (resolveFreshFeedVertical(vertical) || isFreshFeedUpstream(vertical))
  ) {
    return rejectHead(req, res);
  }
  return res.status(404).end();
}

function buildUpstreamTarget(
  originalUrl: string,
  upstreamPath: string,
  forcedSubcategory?: string,
): { target: string } | { error: string } {
  const queryStart = originalUrl.indexOf("?");
  const rawQuery = queryStart === -1 ? "" : originalUrl.slice(queryStart);
  if (!forcedSubcategory) {
    return { target: upstreamPath + rawQuery };
  }

  const rawQueryBody =
    queryStart === -1 ? "" : originalUrl.slice(queryStart + 1);
  const inboundSubcategories = new URLSearchParams(rawQueryBody).getAll(
    "subcategory",
  );
  if (
    inboundSubcategories.length > 1 ||
    (inboundSubcategories.length === 1 &&
      inboundSubcategories[0] !== forcedSubcategory)
  ) {
    return {
      error: "The subcategory parameter conflicts with this vertical route.",
    };
  }
  if (inboundSubcategories.length === 1) {
    return { target: upstreamPath + rawQuery };
  }

  const encoded = encodeURIComponent(forcedSubcategory);
  if (rawQueryBody.length === 0) {
    return { target: `${upstreamPath}?subcategory=${encoded}` };
  }
  const sep = rawQueryBody.endsWith("&") ? "" : "&";
  return {
    target: `${upstreamPath}?${rawQueryBody}${sep}subcategory=${encoded}`,
  };
}

function resolveFreshFeedTarget(
  upstreams: FreshFeedUpstreamUrls,
  spec: FreshFeedRouteSpec,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const teamId = authedReq.auth?.team_id;
    let upstream: FreshFeedUpstream;
    let forcedSubcategory: string | undefined;

    if (spec.kind === "local") {
      const flagUpstream: unknown = authedReq.acuc?.flags?.freshFeedUpstream;
      if (flagUpstream === undefined || flagUpstream === null) {
        upstream = "local";
      } else if (isFreshFeedUpstream(flagUpstream)) {
        upstream = flagUpstream;
      } else {
        rootLogger.error("Invalid freshFeedUpstream flag", {
          module: "api/fresh-feed",
          teamId,
          configuredUpstream:
            typeof flagUpstream === "string"
              ? flagUpstream.slice(0, 64)
              : typeof flagUpstream,
        });
        return freshFeedError(res, 503, "The feed is temporarily unavailable.");
      }
    } else if (spec.kind === "curated") {
      upstream = "curated";
    } else {
      const rawVertical = req.params.vertical;
      const vertical =
        typeof rawVertical === "string"
          ? resolveFreshFeedVertical(rawVertical)
          : undefined;
      if (vertical) {
        upstream = vertical.upstream;
        forcedSubcategory = vertical.subcategory;
      } else if (isFreshFeedUpstream(rawVertical)) {
        upstream = rawVertical;
      } else {
        return freshFeedError(res, 404, "Unknown fresh feed vertical.");
      }
    }

    const builtTarget = buildUpstreamTarget(
      req.originalUrl,
      freshFeedUpstreamPath(upstream),
      forcedSubcategory,
    );
    if ("error" in builtTarget) {
      return freshFeedError(res, 400, builtTarget.error);
    }

    const upstreamBase = upstreams[upstream];
    if (!upstreamBase) {
      rootLogger.error("Fresh feed upstream is not configured", {
        module: "api/fresh-feed",
        teamId,
        upstream,
      });
      return freshFeedError(res, 503, "The feed is temporarily unavailable.");
    }

    const rawCollection: unknown = authedReq.acuc?.flags?.freshFeedCollection;
    let collection: string | undefined;
    if (rawCollection !== undefined && rawCollection !== null) {
      if (!isValidFreshFeedCollection(rawCollection)) {
        rootLogger.error("Invalid freshFeedCollection flag", {
          module: "api/fresh-feed",
          teamId,
          upstream,
          flagType: typeof rawCollection,
        });
        return freshFeedError(res, 503, "The feed is temporarily unavailable.");
      }
      collection = rawCollection;
    }

    (res.locals as Record<symbol, ResolvedFreshFeedTarget>)[RESOLVED_TARGET] = {
      upstream,
      upstreamBase,
      target: builtTarget.target,
      collection,
    };
    next();
  };
}

function freshFeedController(timeoutMs: number) {
  return async (req: Request, res: Response) => {
    const resolved = (res.locals as Record<symbol, ResolvedFreshFeedTarget>)[
      RESOLVED_TARGET
    ];
    if (!resolved) {
      return freshFeedError(res, 503, "The feed is temporarily unavailable.");
    }

    const authedReq = req as RequestWithAuth<any, any, any>;
    const zeroDataRetention =
      getEffectiveSearchForcedKind(authedReq.acuc?.flags, undefined) !== null;

    const started: number = (req as any).requestTiming?.startTime ?? Date.now();
    const jobId = uuidv7();
    const logger = rootLogger.child({
      module: "api/fresh-feed",
      jobId,
      teamId: authedReq.auth.team_id,
      upstream: resolved.upstream,
      zeroDataRetention,
    });

    const { upstreamBase, target, collection } = resolved;

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

    const headers: Record<string, string | string[] | undefined> = {
      "accept-encoding": req.headers["accept-encoding"],
    };
    if (collection) {
      headers[FRESH_FEED_COLLECTION_HEADER] = collection;
    }

    let upstream: Dispatcher.ResponseData;
    try {
      // fetch always decodes the body; request hands back the feed's bytes as sent.
      upstream = await request(upstreamBase + target, {
        headers,
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
  upstream: string | FreshFeedUpstreamUrls,
  timeoutMs = TIMEOUT_MS,
) {
  const upstreams = normalizeFreshFeedUpstreams(upstream);
  const router = express.Router();
  const controller = wrap(freshFeedController(timeoutMs));

  const mountRoute = (
    path: string,
    spec: FreshFeedRouteSpec,
    headHandler: express.RequestHandler = rejectHead,
  ) => {
    router.head(path, headHandler);
    router.get(
      path,
      requireFreshFeedFlag,
      resolveFreshFeedTarget(upstreams, spec),
      requireFreshFeedCredits,
      compression(),
      controller,
    );
  };

  mountRoute("/local/latest", { kind: "local" });
  mountRoute("/curated/latest", { kind: "curated" });
  mountRoute("/:vertical/latest", { kind: "vertical" }, rejectVerticalHead);
  return router;
}
