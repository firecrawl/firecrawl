import { Histogram } from "prom-client";
import type { Request } from "express";
import { z } from "zod";
import { redactAdminKey } from "./admin-auth";

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

const routeWithPathSchema = z.object({
  path: z.union([
    z.string().min(1),
    z.instanceof(RegExp),
    z.array(z.union([z.string(), z.instanceof(RegExp)])).min(1),
  ]),
});

/** Called by the terminal not-found handler before it answers. */
export function markRouteUnmatched(req: Request): void {
  Reflect.set(req, UNMATCHED_FLAG, true);
}

export function getRoutePattern(req: Request): string {
  const route = routeWithPathSchema.safeParse(req.route);
  if (route.success) {
    return String(route.data.path);
  }
  if (UNMATCHED_FLAG in req && req[UNMATCHED_FLAG] === true) {
    return UNMATCHED_ROUTE;
  }
  return redactAdminKey(req.path).replaceAll(UUID_REGEX, ":id");
}
