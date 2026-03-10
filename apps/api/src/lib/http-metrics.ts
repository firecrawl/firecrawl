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

export function getRoutePattern(req: Request): string {
  if (req.route?.path) {
    return req.route.path;
  }
  return req.path.replace(UUID_REGEX, ":id");
}
