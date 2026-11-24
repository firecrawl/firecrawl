import cors from "cors";
import type {
  Application,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
} from "rate-limiter-flexible";
import { Agent, fetch } from "undici";
import { config } from "../config";
import { logger as rootLogger } from "../lib/logger";
import { redisRateLimitClient } from "../services/rate-limiter";

// Marketplace listing files go through here, never straight to the storage bucket: a browser or
// an agent PUTs a file's bytes to an upload link and GETs it back from a download link, and these
// routes stream both straight through to Exchange, which streams to and from the bucket.
//
// There is no API key on either: Exchange's signed, short-lived token in the path is the whole
// permission. Nothing here reads, parses or buffers the body, or logs the token or the URL.

/** The largest listing file Exchange takes: 50 MiB. */
export const EXCHANGE_FILE_MAX_BYTES = 52_428_800;
/** Exchange's token: a base64url payload and a base64url signature. */
const FILE_TOKEN = /^[A-Za-z0-9_-]{16,2048}\.[A-Za-z0-9_-]{16,128}$/;
// Within the server's five-minute limit on receiving a request.
const UPLOAD_TIMEOUT_MS = 4 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const UPSTREAM_IDLE_MS = 60_000;
const FILE_REQUESTS_PER_WINDOW = 600;
const FILE_WINDOW_SECONDS = 600;

const UPLOAD_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "x-request-id",
];
const DOWNLOAD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-security-policy",
  "x-content-type-options",
  "cache-control",
  "x-request-id",
];

/** The website and its Vercel previews; nothing else may upload or download from a browser. */
export const EXCHANGE_FILE_ORIGINS: (string | RegExp)[] = [
  "https://www.firecrawl.dev",
  "https://firecrawl.dev",
  /^https:\/\/[a-z0-9-]+-side-guide\.vercel\.app$/,
];

const filesCors = cors({
  origin: EXCHANGE_FILE_ORIGINS,
  methods: ["PUT", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"],
  maxAge: 600,
});

const uploadDispatcher = new Agent({
  connectTimeout: UPSTREAM_IDLE_MS,
  headersTimeout: UPLOAD_TIMEOUT_MS,
  bodyTimeout: UPSTREAM_IDLE_MS,
});
const downloadDispatcher = new Agent({
  connectTimeout: UPSTREAM_IDLE_MS,
  headersTimeout: UPSTREAM_IDLE_MS,
  bodyTimeout: UPSTREAM_IDLE_MS,
});

const filesLogger = (route: string) =>
  rootLogger.child({ module: "api/exchange-files", route });

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

function upstreamBase(): string | null {
  if (!config.FIRE_EXCHANGE_URL) return null;
  return config.FIRE_EXCHANGE_URL.replace(/\/+$/, "");
}

// Per IP, as for proof links. Fails closed: a limiter error answers 429 rather than reaching the
// global error handler, which logs the request path and with it the token.
function filesRateLimit(keyPrefix: string): RequestHandler {
  const memory = new RateLimiterMemory({
    points: FILE_REQUESTS_PER_WINDOW,
    duration: FILE_WINDOW_SECONDS,
  });
  const limiter = config.REDIS_RATE_LIMIT_URL
    ? new RateLimiterRedis({
        storeClient: redisRateLimitClient,
        keyPrefix,
        points: FILE_REQUESTS_PER_WINDOW,
        duration: FILE_WINDOW_SECONDS,
      })
    : memory;
  return async (req, res, next) => {
    try {
      await limiter.consume(req.ip ?? "unknown");
      next();
    } catch (rejection) {
      if (!(rejection instanceof RateLimiterRes)) {
        filesLogger(keyPrefix).error("File rate limiter failed", {
          error: rejection,
        });
      }
      const seconds =
        rejection instanceof RateLimiterRes
          ? Math.max(1, Math.ceil(rejection.msBeforeNext / 1000))
          : FILE_WINDOW_SECONDS;
      res.setHeader("Retry-After", String(seconds));
      fail(res, 429, "Too many requests. Try again later.");
    }
  };
}

function fileGate(kind: "upload" | "download") {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.params.token;
    if (typeof token !== "string" || !FILE_TOKEN.test(token)) {
      return fail(res, 400, "This file link is not valid.");
    }
    const base = upstreamBase();
    if (!base) return fail(res, 503, "This endpoint is not available.");
    res.locals.fileUpstream = `${base}/v1/files/${kind}/${token}`;
    next();
  };
}

/** The upload must say how big it is, and be no bigger than a listing file can be. */
function uploadSize(req: Request, res: Response, next: NextFunction) {
  const declared = req.headers["content-length"];
  if (
    req.headers["transfer-encoding"] !== undefined ||
    declared === undefined
  ) {
    return fail(res, 411, "Send the file with a Content-Length header.");
  }
  if (!/^\d+$/.test(declared)) {
    return fail(res, 400, "Content-Length must be a number of bytes.");
  }
  if (Number(declared) > EXCHANGE_FILE_MAX_BYTES) {
    return fail(res, 413, "A listing file may be at most 50 MiB.");
  }
  next();
}

function forwardedHeaders(req: Request): Record<string, string> {
  const id = req.headers["x-request-id"];
  return typeof id === "string" ? { "x-request-id": id } : {};
}

function copyHeaders(
  res: Response,
  upstream: { headers: { get(name: string): string | null } },
  names: string[],
) {
  for (const name of names) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function upstreamFailure(res: Response, route: string, error: unknown) {
  const timedOut =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  filesLogger(route).warn("Exchange file transfer failed", {
    reason: timedOut ? "timeout" : "error",
    name: error instanceof Error ? error.name : typeof error,
  });
  if (res.headersSent) {
    res.destroy();
    return;
  }
  return fail(
    res,
    timedOut ? 504 : 502,
    "The file could not be transferred. Try again.",
  );
}

/** Streams the request body to Exchange as it arrives; the reply is Exchange's own. */
async function uploadController(req: Request, res: Response) {
  const route = "PUT /exchange/files/upload/:token";
  const contentType = req.headers["content-type"];
  const abandoned = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abandoned.abort();
  });
  try {
    const upstream = await fetch(res.locals.fileUpstream, {
      method: "PUT",
      headers: {
        ...forwardedHeaders(req),
        ...(typeof contentType === "string"
          ? { "content-type": contentType }
          : {}),
        "content-length": String(req.headers["content-length"]),
      },
      body: req as unknown as AsyncIterable<Uint8Array>,
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.any([
        abandoned.signal,
        AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      ]),
      dispatcher: uploadDispatcher,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return fail(res, 502, "The request could not be completed.");
    }
    if (upstream.status >= 500) {
      filesLogger(route).warn("Exchange file upload error", {
        status: upstream.status,
      });
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    copyHeaders(res, upstream, UPLOAD_RESPONSE_HEADERS);
    return res.status(upstream.status).send(body);
  } catch (error: unknown) {
    return upstreamFailure(res, route, error);
  }
}

/** Streams the file from Exchange to the caller, with Exchange's status and headers. */
async function downloadController(req: Request, res: Response) {
  const route = "GET /exchange/files/download/:token";
  // A caller that goes away stops the transfer upstream too.
  const abandoned = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abandoned.abort();
  });
  try {
    const upstream = await fetch(res.locals.fileUpstream, {
      method: "GET",
      headers: forwardedHeaders(req),
      redirect: "manual",
      signal: AbortSignal.any([
        abandoned.signal,
        AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ]),
      dispatcher: downloadDispatcher,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return fail(res, 502, "The request could not be completed.");
    }
    if (upstream.status >= 500) {
      filesLogger(route).warn("Exchange file download error", {
        status: upstream.status,
      });
    }
    copyHeaders(res, upstream, DOWNLOAD_RESPONSE_HEADERS);
    res.status(upstream.status);
    if (!upstream.body) return res.end();
    const body = Readable.fromWeb(upstream.body as WebReadableStream);
    body.on("error", error => upstreamFailure(res, route, error));
    body.pipe(res);
  } catch (error: unknown) {
    return upstreamFailure(res, route, error);
  }
}

const wrapAsync =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

/**
 * Registers the two file routes on the app itself, before the global body parsers and the
 * catch-all CORS: the body must reach Exchange untouched whatever its type, and only the website
 * may call these from a browser.
 */
export function registerExchangeFileRoutes(
  app: Pick<Application, "put" | "get" | "options">,
) {
  const uploadPath = "/exchange/files/upload/:token";
  const downloadPath = "/exchange/files/download/:token";
  app.options(uploadPath, filesCors);
  app.options(downloadPath, filesCors);
  app.put(
    uploadPath,
    filesCors,
    fileGate("upload"),
    filesRateLimit("exchange-file-upload"),
    uploadSize,
    wrapAsync(uploadController),
  );
  app.get(
    downloadPath,
    filesCors,
    fileGate("download"),
    filesRateLimit("exchange-file-download"),
    wrapAsync(downloadController),
  );
}
