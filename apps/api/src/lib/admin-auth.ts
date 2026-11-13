import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Counter } from "prom-client";
import { config } from "../config";
import { logAuthDenied } from "./auth-denied-log";
import { logger } from "./logger";

export function bearerToken(
  value: string | string[] | undefined,
): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.slice(0, 7).toLowerCase() === "bearer "
    ? header.slice(7)
    : null;
}

export function secretsMatch(
  provided: string | null,
  expected?: string,
): boolean {
  if (!provided || !expected?.trim()) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export const ADMIN_KEY_HEADER = "x-firecrawl-admin-key";

export type AdminKeySlot = "current" | "previous";

// The one admin key check, shared by the header and path forms.
function matchAdminKey(provided: string | null): AdminKeySlot | null {
  if (secretsMatch(provided, config.BULL_AUTH_KEY)) return "current";
  if (secretsMatch(provided, config.BULL_AUTH_KEY_PREVIOUS)) return "previous";
  return null;
}

/** Replaces every path segment that is an admin key, so the path is safe to log. */
export function redactAdminKey(path: string): string {
  return path
    .split("/")
    .map(segment => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      return matchAdminKey(segment) || matchAdminKey(decoded)
        ? ":bullAuthKey"
        : segment;
    })
    .join("/");
}

function logAdminAuthenticated(req: Request, matchedKey: string) {
  logger.info("Admin request authenticated", {
    method: req.method,
    path: redactAdminKey(`${req.baseUrl}${req.path}`),
    matchedKey,
  });
}

function authorizeAdminKey(
  provided: string | null,
  missing: boolean,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const matched = matchAdminKey(provided);

  if (!matched) {
    logAuthDenied(
      req,
      401,
      missing
        ? "missing_credentials"
        : provided
          ? "unknown_key"
          : "malformed_authorization",
    );
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  logAdminAuthenticated(req, matched);
  next();
}

/**
 * Accepts `Authorization: Bearer` matching BULL_AUTH_KEY, or BULL_AUTH_KEY_PREVIOUS
 * while callers move to a new key. Logs which key matched, never its value.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  authorizeAdminKey(
    bearerToken(req.headers.authorization),
    !req.headers.authorization,
    req,
    res,
    next,
  );
}

/**
 * Same keys as adminAuth, read from ADMIN_KEY_HEADER, for admin routes whose
 * Authorization header carries a team API key.
 */
export function adminKeyHeaderAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const value = req.headers[ADMIN_KEY_HEADER];
  const provided = (Array.isArray(value) ? value[0] : value) || null;
  authorizeAdminKey(provided, !provided, req, res, next);
}

// Fixed, bounded labels only: never the key or the raw request path.
const adminPathRouteRequests = new Counter({
  name: "firecrawl_admin_path_route_requests_total",
  help: "Requests to admin routes that take the key as a path segment",
  labelNames: ["route", "caller"],
});

const ADMIN_PATH_ROUTE_NAMES: ReadonlySet<string> = new Set([
  "redis-health",
  "acuc-cache-clear",
  "ip-restriction-cache-clear",
  "key-restriction-cache-clear",
  "feng-check",
  "index-queue-prometheus",
  "precrawl",
  "metrics",
  "nuq-metrics",
  "nuq-fdb-metrics",
  "fsearch",
  "concurrency-queue-backfill",
  "crawl-monitor",
]);

function callerOf(req: Request): string {
  const agent = req.headers["user-agent"] ?? "";
  if (/prometheus|victoriametrics|vmagent/i.test(agent)) return "prometheus";
  if (/mozilla/i.test(agent)) return "browser";
  if (/node|undici|axios/i.test(agent)) return "server";
  return "other";
}

/**
 * Checks the `:adminKey` path segment with the same check as the header forms
 * and counts the use. A wrong key leaves the router, so it answers 404 like an
 * unknown path. Use inside a router created with `mergeParams: true`.
 */
export function adminPathKeyAuth(route?: "queues") {
  return (req: Request, res: Response, next: NextFunction) => {
    const params = req.params as Record<string, string | undefined>;
    const matched = matchAdminKey(params.adminKey ?? null);
    if (!matched) return next("router");

    const segment = req.path.split("/")[1] ?? "";
    adminPathRouteRequests.inc({
      route: route ?? (ADMIN_PATH_ROUTE_NAMES.has(segment) ? segment : "other"),
      caller: callerOf(req),
    });
    res.locals.adminKeySlot = matched;
    logAdminAuthenticated(req, matched);
    next();
  };
}
