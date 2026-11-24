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
  FRESH_FEED_FILTER_KEYS,
  FRESH_FEED_UPSTREAM_ROUTES,
  MAX_FRESH_FEED_AGENTS,
  freshFeedUpstreamPath,
  isFreshFeedUpstream,
  isValidFreshFeedAgentToken,
  isValidFreshFeedCollection,
  normalizeFreshFeedHostToken,
  normalizeFreshFeedUpstreams,
  parseFreshFeedFilters,
  resolveFreshFeedVertical,
  type FreshFeedFilterKey,
  type FreshFeedFilters,
  type FreshFeedUpstream,
  type FreshFeedUpstreamRouteDefinition,
  type FreshFeedUpstreamUrls,
} from "../lib/fresh-feed";
import {
  freshFeedBillingCountErrorsTotal,
  freshFeedUpstreamRequestDurationSeconds,
} from "../lib/fresh-feed-metrics";
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
const DEFAULT_PRECHECK_LIMIT = 50;
const MAX_CONTENT_PAGE_SIZE = 50;
const MAX_METADATA_PAGE_SIZE = 500;
const RESOLVED_TARGET = Symbol("freshFeedResolvedTarget");
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "content-length",
  "vary",
];

type FreshFeedRouteSpec =
  | { kind: "upstream"; route: FreshFeedUpstreamRouteDefinition }
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

function getResolvedTarget(res: Response): ResolvedFreshFeedTarget | undefined {
  return (res.locals as Record<symbol, ResolvedFreshFeedTarget | undefined>)[
    RESOLVED_TARGET
  ];
}

function precheckRecordCount(req: Request): number {
  const rawContent = req.query.content;
  const isMetadataPage =
    typeof rawContent === "string"
      ? rawContent.toLowerCase() === "false"
      : Array.isArray(rawContent) &&
        rawContent.some(
          value => typeof value === "string" && value.toLowerCase() === "false",
        );
  const maxLimit = isMetadataPage
    ? MAX_METADATA_PAGE_SIZE
    : MAX_CONTENT_PAGE_SIZE;

  const rawLimit = req.query.limit;
  if (rawLimit !== undefined && typeof rawLimit !== "string") {
    return maxLimit;
  }
  if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit.trim())) {
    return Math.min(DEFAULT_PRECHECK_LIMIT, maxLimit);
  }
  const parsed = Number.parseInt(rawLimit.trim(), 10);
  if (parsed < 1) {
    return Math.min(DEFAULT_PRECHECK_LIMIT, maxLimit);
  }
  return Math.min(parsed, maxLimit);
}

function requireFreshFeedCredits(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const rate = creditsPerRecord(req);
  if (rate === 0) return next();
  const resolved = getResolvedTarget(res);
  const records =
    resolved !== undefined && resolved.upstream !== "local"
      ? precheckRecordCount(req)
      : 1;
  const requiredCredits = Math.min(Number.MAX_SAFE_INTEGER, records * rate);
  return checkCreditsMiddleware(requiredCredits)(
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
  if (typeof vertical === "string" && resolveFreshFeedVertical(vertical)) {
    return rejectHead(req, res);
  }
  return res.status(404).end();
}

const INVALID_AGENTS_ERROR =
  "agents is 1 to 4 robots.txt product tokens, comma-separated, each of letters, - and _";

function normalizeFilterToken(key: FreshFeedFilterKey, token: string): string {
  return key === "domain" || key === "host"
    ? normalizeFreshFeedHostToken(token)
    : token;
}

function isAllowedFilterSubset(
  key: FreshFeedFilterKey,
  inbound: string,
  lockedValue: string,
): boolean {
  const allowed = new Set(
    lockedValue.split(",").map(token => normalizeFilterToken(key, token)),
  );
  const requested = inbound.split(",");
  if (requested.length === 0 || requested.length > allowed.size) return false;
  const seen = new Set<string>();
  for (const token of requested) {
    const normalized = normalizeFilterToken(key, token);
    if (
      normalized.length === 0 ||
      !allowed.has(normalized) ||
      seen.has(normalized)
    ) {
      return false;
    }
    seen.add(normalized);
  }
  return true;
}

function validateAgentsSuperset(
  inbound: string,
  lockedValue: string,
): string | undefined {
  const requested = inbound.split(",");
  if (requested.length === 0 || requested.length > MAX_FRESH_FEED_AGENTS) {
    return INVALID_AGENTS_ERROR;
  }
  const requestedFolded = new Set<string>();
  for (const token of requested) {
    if (!isValidFreshFeedAgentToken(token)) {
      return INVALID_AGENTS_ERROR;
    }
    requestedFolded.add(token.toLowerCase());
  }
  for (const required of lockedValue.split(",")) {
    if (!requestedFolded.has(required.toLowerCase())) {
      return "The agents parameter conflicts with the configured feed filter.";
    }
  }
  return undefined;
}

function buildUpstreamTarget(
  originalUrl: string,
  upstreamPath: string,
  lockedFilters: FreshFeedFilters,
  forcedSubcategory?: string,
): { target: string } | { error: string } {
  const queryStart = originalUrl.indexOf("?");
  const rawQuery = queryStart === -1 ? "" : originalUrl.slice(queryStart);
  const activeKeys = FRESH_FEED_FILTER_KEYS.filter(
    key => lockedFilters[key] !== undefined,
  );
  if (activeKeys.length === 0) {
    return { target: upstreamPath + rawQuery };
  }

  const rawQueryBody =
    queryStart === -1 ? "" : originalUrl.slice(queryStart + 1);
  const inboundParams = new URLSearchParams(rawQueryBody);
  const toAppend: string[] = [];

  for (const key of activeKeys) {
    const lockedValue = lockedFilters[key]!;
    const inboundValues = inboundParams.getAll(key);
    if (inboundValues.length > 1) {
      return {
        error:
          key === "subcategory" && forcedSubcategory
            ? "The subcategory parameter conflicts with this vertical route."
            : `The ${key} parameter conflicts with the configured feed filter.`,
      };
    }
    if (inboundValues.length === 1) {
      if (key === "agents") {
        const agentsError = validateAgentsSuperset(
          inboundValues[0],
          lockedValue,
        );
        if (agentsError) {
          return { error: agentsError };
        }
        continue;
      }
      if (!isAllowedFilterSubset(key, inboundValues[0], lockedValue)) {
        return {
          error:
            key === "subcategory" && forcedSubcategory
              ? "The subcategory parameter conflicts with this vertical route."
              : `The ${key} parameter conflicts with the configured feed filter.`,
        };
      }
      continue;
    }
    const encodedValue = lockedValue
      .split(",")
      .map(encodeURIComponent)
      .join(",");
    toAppend.push(`${key}=${encodedValue}`);
  }

  if (toAppend.length === 0) {
    return { target: upstreamPath + rawQuery };
  }
  const suffix = toAppend.join("&");
  if (rawQueryBody.length === 0) {
    return { target: `${upstreamPath}?${suffix}` };
  }
  const sep = rawQueryBody.endsWith("&") ? "" : "&";
  return { target: `${upstreamPath}?${rawQueryBody}${sep}${suffix}` };
}

function resolveFreshFeedTarget(
  upstreams: FreshFeedUpstreamUrls,
  spec: FreshFeedRouteSpec,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authedReq = req as RequestWithAuth<any, any, any>;
    const teamId = authedReq.auth?.team_id;
    let allowedUpstreams: readonly FreshFeedUpstream[];
    let defaultUpstream: FreshFeedUpstream | undefined;
    let forcedSubcategory: string | undefined;

    if (spec.kind === "upstream") {
      allowedUpstreams = spec.route.allowedUpstreams;
      defaultUpstream = spec.route.defaultUpstream;
    } else {
      const rawVertical = req.params.vertical;
      const vertical =
        typeof rawVertical === "string"
          ? resolveFreshFeedVertical(rawVertical)
          : undefined;
      if (!vertical) {
        return freshFeedError(res, 404, "Unknown fresh feed vertical.");
      }
      allowedUpstreams = vertical.supportedUpstreams;
      forcedSubcategory = vertical.subcategory;
    }

    const flagUpstream: unknown = authedReq.acuc?.flags?.freshFeedUpstream;
    let upstream: FreshFeedUpstream;
    if (flagUpstream === undefined || flagUpstream === null) {
      if (defaultUpstream === undefined) {
        return freshFeedError(
          res,
          403,
          "This endpoint is not enabled for this team.",
        );
      }
      upstream = defaultUpstream;
    } else if (!isFreshFeedUpstream(flagUpstream)) {
      rootLogger.error("Invalid freshFeedUpstream flag", {
        module: "api/fresh-feed",
        teamId,
        configuredUpstream:
          typeof flagUpstream === "string"
            ? flagUpstream.slice(0, 64)
            : typeof flagUpstream,
      });
      return freshFeedError(res, 503, "The feed is temporarily unavailable.");
    } else if (!allowedUpstreams.includes(flagUpstream)) {
      return freshFeedError(
        res,
        403,
        "This endpoint is not enabled for this team.",
      );
    } else {
      upstream = flagUpstream;
    }

    const parsedFilters = parseFreshFeedFilters(
      authedReq.acuc?.flags?.freshFeedFilters,
    );
    if ("error" in parsedFilters) {
      rootLogger.error("Invalid freshFeedFilters flag", {
        module: "api/fresh-feed",
        teamId,
        upstream,
        reason: parsedFilters.error,
      });
      return freshFeedError(res, 503, "The feed is temporarily unavailable.");
    }

    const effectiveFilters: FreshFeedFilters = { ...parsedFilters.filters };
    if (forcedSubcategory) {
      if (
        effectiveFilters.subcategory !== undefined &&
        !effectiveFilters.subcategory.split(",").includes(forcedSubcategory)
      ) {
        return freshFeedError(
          res,
          403,
          "This endpoint is not enabled for this team.",
        );
      }
      effectiveFilters.subcategory = forcedSubcategory;
    }

    const builtTarget = buildUpstreamTarget(
      req.originalUrl,
      freshFeedUpstreamPath(upstream),
      effectiveFilters,
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
    const resolved = getResolvedTarget(res);
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

    const upstreamStarted = Date.now();
    const observeUpstream = (
      status: string,
      seconds = (Date.now() - upstreamStarted) / 1000,
    ) => {
      freshFeedUpstreamRequestDurationSeconds
        .labels(resolved.upstream, status)
        .observe(seconds);
    };

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
      if (callerGone.signal.aborted) {
        observeUpstream("aborted");
        return;
      }
      if ((error as { code?: unknown })?.code === "UND_ERR_HEADERS_TIMEOUT") {
        observeUpstream("504");
        logger.error("Fresh feed timed out");
        return freshFeedError(res, 504, "The request timed out.");
      }
      observeUpstream("502");
      logger.error("Fresh feed proxy error", { error });
      return freshFeedError(res, 502, "The request could not be completed.");
    }
    const upstreamResponseSeconds = (Date.now() - upstreamStarted) / 1000;

    if (![200, 400, 406].includes(upstream.statusCode)) {
      upstream.body.dump().catch(() => {});
      logger.error("Fresh feed upstream error", {
        status: upstream.statusCode,
        seconds: (Date.now() - started) / 1000,
      });
      if (upstream.statusCode === 500 || upstream.statusCode === 503) {
        observeUpstream("503", upstreamResponseSeconds);
        res.setHeader("Retry-After", "5");
        return freshFeedError(
          res,
          503,
          "The feed is temporarily unavailable. Retry the same request.",
        );
      }
      observeUpstream("502", upstreamResponseSeconds);
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
    observeUpstream(
      delivered ? String(upstream.statusCode) : "stream_error",
      delivered ? upstreamResponseSeconds : undefined,
    );
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
        freshFeedBillingCountErrorsTotal.inc({ upstream: resolved.upstream });
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

  for (const route of FRESH_FEED_UPSTREAM_ROUTES) {
    mountRoute(route.path, { kind: "upstream", route });
  }
  mountRoute("/:vertical/latest", { kind: "vertical" }, rejectVerticalHead);
  return router;
}
