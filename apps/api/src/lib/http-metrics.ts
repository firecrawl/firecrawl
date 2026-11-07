import { Histogram } from "prom-client";
import type { Request } from "express";

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["version", "method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
});

/**
 * Single `route` label for every request that matched no route. Without it the
 * fallback below would mint a new time series per scanned URL, since unmatched
 * requests reach the terminal handler and answer with `res.json`, which the
 * timing middleware observes.
 */
const UNMATCHED_ROUTE = "unmatched";

const UNMATCHED_FLAG = Symbol.for("firecrawl.httpMetrics.unmatchedRoute");

/** Called by the terminal not-found handler before it answers. */
export function markRouteUnmatched(req: Request): void {
  (req as unknown as Record<symbol, boolean>)[UNMATCHED_FLAG] = true;
}

export function getRoutePattern(req: Request): string {
  if (req.route?.path) {
    return req.route.path;
  }
  if ((req as unknown as Record<symbol, boolean>)[UNMATCHED_FLAG] === true) {
    return UNMATCHED_ROUTE;
  }
  return req.path.replace(UUID_REGEX, ":id");
}
