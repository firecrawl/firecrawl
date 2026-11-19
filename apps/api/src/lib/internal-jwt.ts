import { createPublicKey, type KeyObject } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { logger } from "./logger";

const INTERNAL_JWT_HEADER = "x-firecrawl-internal-token";
const INTERNAL_JWT_AUDIENCE = "firecrawl-api";
const MAX_TTL_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

export type InternalCaller = { issuer: string; requestId: string };

type IssuerKeys = Map<string, KeyObject>;

let cached: { raw: string; issuers: Map<string, IssuerKeys> } | undefined;

/** Parses INTERNAL_JWT_PUBLIC_KEYS: {"<issuer>": {"<kid>": "<SPKI PEM>"}}; two kids per issuer allow rotation. */
function loadIssuers(): Map<string, IssuerKeys> {
  const raw = config.INTERNAL_JWT_PUBLIC_KEYS;
  if (!raw) throw new Error("internal JWT public keys are not configured");
  if (cached?.raw === raw) return cached.issuers;
  const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
  const issuers = new Map<string, IssuerKeys>();
  for (const [issuer, keys] of Object.entries(parsed)) {
    issuers.set(
      issuer,
      new Map(
        Object.entries(keys).map(([kid, pem]) => [kid, createPublicKey(pem)]),
      ),
    );
  }
  if (issuers.size === 0) throw new Error("internal JWT public keys are empty");
  cached = { raw, issuers };
  return issuers;
}

class InternalJwtError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

/** Verifies a per-request internal JWT and that it was minted for `expectedTeamId`. */
export async function verifyInternalJwt(
  token: string,
  expectedTeamId: string,
): Promise<InternalCaller> {
  let issuers: Map<string, IssuerKeys>;
  try {
    issuers = loadIssuers();
  } catch {
    throw new InternalJwtError(401, "Internal auth is not configured");
  }

  try {
    const { kid, alg } = decodeProtectedHeader(token);
    const issuer = decodeJwt(token).iss;
    const key = issuer && kid ? issuers.get(issuer)?.get(kid) : undefined;
    if (alg !== "EdDSA" || !issuer || !key) throw new Error("unknown key");

    const { payload } = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      issuer,
      audience: INTERNAL_JWT_AUDIENCE,
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ["iat", "exp", "jti", "team_id", "request_id"],
    });
    const { iat, exp } = payload;
    if (typeof iat !== "number" || typeof exp !== "number") {
      throw new Error("bad time claims");
    }
    if (exp - iat > MAX_TTL_SECONDS) throw new Error("ttl too long");
    if (iat > Date.now() / 1000 + CLOCK_SKEW_SECONDS) {
      throw new Error("iat in the future");
    }
    if (typeof payload.team_id !== "string") throw new Error("bad team_id");
    if (typeof payload.request_id !== "string")
      throw new Error("bad request_id");
    if (payload.team_id !== expectedTeamId) {
      throw new InternalJwtError(403, "Token team does not match request");
    }
    return { issuer, requestId: payload.request_id };
  } catch (error) {
    if (error instanceof InternalJwtError) throw error;
    throw new InternalJwtError(401, "Invalid internal token");
  }
}

/**
 * Runs after API key auth. With the flag off the header is ignored; with it on,
 * a present header must verify, and missing keys fail closed.
 */
export function internalJwtMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers[INTERNAL_JWT_HEADER];
    if (!config.INTERNAL_JWT_ENABLED || token === undefined) return next();
    const teamId = (req as any).auth?.team_id;
    try {
      if (typeof token !== "string" || !teamId) {
        throw new InternalJwtError(401, "Invalid internal token");
      }
      res.locals.internalCaller = await verifyInternalJwt(token, teamId);
      return next();
    } catch (error) {
      const denied =
        error instanceof InternalJwtError
          ? error
          : new InternalJwtError(401, "Invalid internal token");
      logger.warn("Internal JWT rejected", { status: denied.status });
      return res.status(denied.status).json({
        success: false,
        error: denied.message,
      });
    }
  };
}
