import crypto from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
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

// req.path keeps percent-encoding. Compare the decoded path, then the raw path.
function pathCandidates(pathname: string): string[] {
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded !== pathname) return [decoded, pathname];
  } catch {
    // Use the raw path when the encoding is not valid.
  }
  return [pathname];
}

function splitAdminSecret(pathname: string, secret: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const candidate = pathname.slice(1, 1 + secret.length);
  if (!secretsMatch(candidate, secret)) return null;
  const rest = pathname.slice(1 + secret.length);
  if (rest === "") return "/";
  if (!rest.startsWith("/")) return null;
  return rest;
}

function remainderAfterAdminSecret(
  pathname: string,
  secret: string,
): string | null {
  for (const candidate of pathCandidates(pathname)) {
    const rest = splitAdminSecret(candidate, secret);
    if (rest != null) return rest;
  }
  return null;
}

function rewriteToSecretRemainder(req: Request, rest: string) {
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
  req.url = `${rest}${query}`;
}

function isQueuePath(rest: string): boolean {
  return rest === "/queues" || rest.startsWith("/queues/");
}

/**
 * Mounted at /admin. Serves the queue UI only when the provided secret matches
 * the configured secret.
 */
export function queueAdminRouter(
  queueApp: RequestHandler,
  onMatch?: RequestHandler,
): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const secret = config.BULL_AUTH_KEY;
    if (!secret || !config.BULL_AUTH_KEY_PATH_ROUTES) return next("router");
    const rest = remainderAfterAdminSecret(req.path, secret);
    if (rest == null || !isQueuePath(rest)) return next("router");
    rewriteToSecretRemainder(req, rest);
    next();
  });
  if (onMatch) router.use(onMatch);
  router.use("/queues", queueApp);
  return router;
}

/**
 * Mounted at /admin. Serves the other path routes only when the provided
 * secret matches the configured secret. Queue paths stay with the queue UI.
 */
export function adminSecretPathRouter(routes: Router): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const secret = config.BULL_AUTH_KEY;
    if (!secret || !config.BULL_AUTH_KEY_PATH_ROUTES) return next("router");
    const rest = remainderAfterAdminSecret(req.path, secret);
    if (rest == null || isQueuePath(rest)) return next("router");
    rewriteToSecretRemainder(req, rest);
    next();
  });
  router.use(routes);
  return router;
}
