/*
 * What a route asks of the service before its handler runs.
 *
 * The code that identifies a sender is loaded by the first request that
 * needs it and not before, so importing the package loads no route code. For
 * the same reason this file imports nothing at the top but types.
 */
import type { RequestHandler } from "express";
import type { RateLimiterMode } from "../types";

type AuthMiddleware = typeof import("../routes/shared").authMiddleware;

/** The kind of route a request arrived on. It decides how its sender is identified and limited. */
export type RouteKind = `${RateLimiterMode}`;

/**
 * Express middleware that identifies the sender of a request. A request it
 * lets through has `req.caller`; a request it refuses has been answered.
 */
export function authenticate(
  kind: RouteKind,
  options?: Parameters<AuthMiddleware>[1],
): RequestHandler {
  let middleware: Promise<RequestHandler> | undefined;
  return (req, res, next) => {
    middleware ??= import("../routes/shared.js").then(
      shared =>
        shared.authMiddleware(
          kind as RateLimiterMode,
          options,
        ) as RequestHandler,
    );
    middleware.then(run => run(req, res, next), next);
  };
}
