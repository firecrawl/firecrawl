/*
 * What a route asks of the service before its handler runs.
 *
 * This file imports nothing with a startup side effect, so importing the
 * package loads no route handlers, configuration, or clients.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Refusal } from "./hooks";
import type { AuthRoute, CoreRouteKind, RouteKind } from "./modules";
import { service } from "./service";

export type { AuthRoute, CoreRouteKind, RouteKind };

/** Sends a ready-made HTTP refusal if the response has not already been sent. */
export function sendRefusal(res: Response, refusal: Refusal): void {
  if (res.headersSent) return;
  for (const [name, value] of Object.entries(refusal.headers ?? {})) {
    res.setHeader(name, value);
  }
  res.status(refusal.status).json(refusal.body);
}

/**
 * Express middleware that identifies the sender of a request through the
 * active service's auth module. A request it lets through has `req.caller`;
 * a request it refuses has been answered.
 */
export function authenticate(
  kind: RouteKind,
  options?: Omit<AuthRoute, "kind">,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const route: AuthRoute = options ? { ...options, kind } : { kind };
    Promise.resolve()
      .then(() => service.modules.auth.authenticate(req, route))
      .then(result => {
        if (!result.ok) {
          sendRefusal(res, result.refusal);
          return;
        }
        if (!res.headersSent) {
          for (const [name, value] of Object.entries(result.headers ?? {})) {
            res.setHeader(name, value);
          }
        }
        req.caller = result.caller;
        next();
      })
      .catch(next);
  };
}
