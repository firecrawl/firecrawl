import type { NextFunction, Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  ErrorResponse,
  RequestWithMaybeACUC,
} from "../controllers/v2/types";
import { redactAdminKey } from "./admin-auth";
import { getRoutePattern } from "./http-metrics";
import { logger } from "./logger";
import { recordUnhandledException } from "./otel-tracer";
import { service } from "../service";

const payloadTooLargeErrorSchema = z.object({
  status: z.literal(413),
});

/**
 * Terminal Express error handler: answers 500 with an error id, logs the
 * failure, and records it as an exception on the request's span (or on a
 * standalone span for routes that run without one), so it shows up in the
 * trace store like the controller-level failures do.
 */
export function unhandledErrorHandler(
  err: unknown,
  req: RequestWithMaybeACUC<Request["params"], ErrorResponse, undefined>,
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
  if (payloadTooLargeErrorSchema.safeParse(err).success) {
    res.status(413).json({
      success: false,
      error: "Request body is too large",
    });
    return;
  }

  const id = uuidv7();

  logger.error("Error occurred in request!", {
    error: err,
    errorId: id,
    path: redactAdminKey(req.path),
    teamId: req.acuc?.team_id,
    team_id: req.acuc?.team_id,
  });
  // Zero data retention is decided once, when the request is accepted, and
  // travels on its context (the tracer keeps those request spans unrecorded).
  // A route that never started a span makes the same call here, since an error
  // message can quote the URL. Only the log line is kept for those, as before.
  // A request that fails before it has a context is judged by what its body
  // asks for.
  const body = req.body as
    | {
        zeroDataRetention?: unknown;
        lockdown?: unknown;
        enterprise?: unknown;
      }
    | undefined;
  const enterprise: Array<unknown> = Array.isArray(body?.enterprise)
    ? body.enterprise
    : [];
  const zeroDataRetention =
    req.ctx?.zeroDataRetention === true ||
    req.ctx?.lockdown === true ||
    body?.zeroDataRetention === true ||
    body?.lockdown === true ||
    enterprise.includes("zdr") ||
    enterprise.includes("anon");
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
    error: service.modules.messages.errorContact(id),
  });
}
