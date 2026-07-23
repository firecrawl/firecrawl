import crypto from "node:crypto";
import express, {
  Application,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import { config } from "../config";
import {
  ingestMcpActionLogController,
  listMcpActionLogsController,
} from "../controllers/v2/mcp-action-logs";
import { wrap } from "./shared";

const BODY_LIMIT = "64kb";
const DEFAULT_LIMIT = 600;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 10_000;

function bearerToken(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function timingSafeSecretEqual(
  provided: string | null,
  expected?: string,
) {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireWritesEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (
    !config.MCP_ACTION_LOG_STORAGE_ENABLED ||
    !config.MCP_ACTION_LOG_WRITES_ENABLED
  ) {
    return res
      .status(503)
      .json({ success: false, error: "MCP action logging is disabled" });
  }
  next();
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  if (
    !timingSafeSecretEqual(
      bearerToken(req.headers.authorization),
      config.MCP_ACTION_LOG_SECRET,
    )
  ) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

export function createMcpActionLogRateLimitMiddleware(options?: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
  maxBuckets?: number;
}): RequestHandler {
  // This runs after the shared-secret check and is deliberately local
  // load-shedding for trusted MCP writers, not a cross-replica billing or
  // security quota. The bounded map prevents stale pod IPs accumulating.
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options?.now ?? Date.now;
  const maxBuckets = options?.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextCleanupAt = 0;
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = now();
    if (current >= nextCleanupAt) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= current) buckets.delete(bucketKey);
      }
      nextCleanupAt = current + windowMs;
    }
    const previous = buckets.get(key);
    if (!previous && buckets.size >= maxBuckets) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil(windowMs / 1000))),
      );
      return res
        .status(429)
        .json({ success: false, error: "Too many MCP action log sources" });
    }
    const bucket =
      !previous || previous.resetAt <= current
        ? { count: 0, resetAt: current + windowMs }
        : previous;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader(
        "Retry-After",
        String(Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))),
      );
      return res
        .status(429)
        .json({ success: false, error: "Too many MCP action log requests" });
    }
    next();
  };
}

export function registerMcpActionLogIngestRoute(
  app: Pick<Application, "post">,
  options?: { rateLimit?: RequestHandler },
) {
  app.post(
    "/v2/mcp/action-logs",
    requireWritesEnabled,
    authenticate,
    options?.rateLimit ?? createMcpActionLogRateLimitMiddleware(),
    // This is a JSON-only internal endpoint. Parse every media type here so
    // callers cannot bypass the route-specific limit with a different
    // Content-Type before the global parser runs.
    express.json({ limit: BODY_LIMIT, type: () => true }),
    wrap(ingestMcpActionLogController),
  );
}

export function registerMcpActionLogReadRoute(
  router: Pick<Router, "get">,
  authenticateViewer: RequestHandler,
) {
  router.get(
    "/mcp/action-logs",
    authenticateViewer,
    wrap(listMcpActionLogsController),
  );
}
