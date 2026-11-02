import type { NextFunction, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import type {
  ErrorResponse,
  RequestWithMaybeACUC,
} from "../controllers/v1/types";
import { getErrorContactMessage } from "./deployment";
import { getRoutePattern } from "./http-metrics";
import { logger } from "./logger";
import { recordUnhandledException } from "./otel-tracer";
import { isLockdownZeroDataRetention } from "./safe-mode";
import { getScrapeZDR } from "./zdr-helpers";

/**
 * Terminal Express error handler: answers 500 with an error id, logs the
 * failure, and records it as an exception on the request's span (or on a
 * standalone span for routes that run without one), so it shows up in the
 * trace store like the controller-level failures do.
 */
export function unhandledErrorHandler(
  err: unknown,
  req: RequestWithMaybeACUC<{}, ErrorResponse, undefined>,
  res: Response<ErrorResponse>,
  _next: NextFunction,
): void {
  if (
    err instanceof SyntaxError &&
    "status" in err &&
    err.status === 400 &&
    "body" in err
  ) {
    res.status(400).json({
      success: false,
      code: "BAD_REQUEST_INVALID_JSON",
      error: "Bad request, malformed JSON",
    });
    return;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 413
  ) {
    res.status(413).json({
      success: false,
      error: "Request body is too large",
    });
    return;
  }

  const id = uuidv7();

  logger.error(
    "Error occurred in request! (" + req.path + ") -- ID " + id + " -- ",
    {
      error: err,
      errorId: id,
      path: req.path,
      teamId: req.acuc?.team_id,
      team_id: req.acuc?.team_id,
    },
  );
  // Zero data retention is decided per request by the controllers (and the
  // tracer keeps those request spans unrecorded); a route that never started
  // a span makes the same call here, since an error message can quote the
  // URL. Only the log line is kept for those, as before.
  const body = req.body as
    | { zeroDataRetention?: unknown; lockdown?: unknown; safeMode?: unknown }
    | undefined;
  const zeroDataRetention =
    getScrapeZDR(req.acuc?.flags) === "forced" ||
    // Safe Mode lockdown orgs retain nothing either, without a scrapeZDR flag.
    isLockdownZeroDataRetention(
      req.acuc?.flags,
      typeof body?.safeMode === "boolean" ? body.safeMode : undefined,
    ) ||
    body?.zeroDataRetention === true ||
    body?.lockdown === true;
  if (!zeroDataRetention) {
    // The matched route pattern and API version, as the request metrics label
    // them; never the raw path, so a URL the caller made up cannot become a
    // new attribute value.
    const timing = (req as { requestTiming?: { version?: unknown } })
      .requestTiming;
    recordUnhandledException(err, {
      "http.method": req.method,
      "http.route": getRoutePattern(req),
      "api.version":
        typeof timing?.version === "string" ? timing.version : undefined,
      "error.id": id,
      "team.id": req.acuc?.team_id,
    });
  }
  res.status(500).json({
    success: false,
    code: "UNKNOWN_ERROR",
    error: getErrorContactMessage(id),
  });
}
