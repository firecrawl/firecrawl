import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
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

function authorizeAdminKey(
  provided: string | null,
  missing: boolean,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const current = secretsMatch(provided, config.BULL_AUTH_KEY);
  const previous = secretsMatch(provided, config.BULL_AUTH_KEY_PREVIOUS);

  if (!current && !previous) {
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

  logger.info("Admin request authenticated", {
    method: req.method,
    path: `${req.baseUrl}${req.path}`,
    matchedKey: current ? "current" : "previous",
  });
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
