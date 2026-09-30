import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { logger } from "./logger";

// Vercel Marketplace OIDC resource tokens. A customer's Vercel deployment mints
// a short-lived RS256 JWT for one of our resources and sends it as the bearer
// credential. We only verify it; Vercel hosts the mint endpoint.

const VERCEL_INTEGRATIONS_ORIGIN = "https://integrations.vercel.com";
// Vercel issues exp = iat + 300 today and may move to 900.
const CLOCK_TOLERANCE_SECONDS = 60;

const DEFAULT_JWKS_MAX_AGE_MS = 60 * 60 * 1000;
const MIN_JWKS_MAX_AGE_MS = 60 * 1000;
// Vercel's contract: keep serving cached keys for up to 24h when a refresh fails.
const JWKS_STALE_LIMIT_MS = 24 * 60 * 60 * 1000;
// Refetches (unknown kid, or retrying after a failure) are rate-limited to one
// per this window.
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface VercelOidcClaims {
  iss: string;
  aud: string;
  sub: string;
  resource: string;
  owner?: string;
  project?: string;
  environment?: string;
  deployment?: string;
  exp: number;
  iat: number;
}

export class VercelJwksUnavailableError extends Error {
  constructor(message = "Vercel Marketplace JWKS is unavailable") {
    super(message);
    this.name = "VercelJwksUnavailableError";
  }
}

export class VercelOidcTokenInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid Vercel Marketplace OIDC token: ${reason}`);
    this.name = "VercelOidcTokenInvalidError";
  }
}

/**
 * Cheap shape check: three base64url segments with a JSON header. Firecrawl
 * API keys (fc-..., bare uuids) never match, so they skip this branch.
 */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ") && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

export function vercelIssuer(integrationId: string): string {
  return `${VERCEL_INTEGRATIONS_ORIGIN}/${integrationId}`;
}

function maxAgeFromCacheControl(header: string | null): number {
  const match = header?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return DEFAULT_JWKS_MAX_AGE_MS;
  return Math.min(
    Math.max(Number(match[1]) * 1000, MIN_JWKS_MAX_AGE_MS),
    JWKS_STALE_LIMIT_MS,
  );
}

/**
 * Remote JWKS resolver following Vercel's key-rotation contract. jose's
 * createRemoteJWKSet ignores Cache-Control and fails closed when a refresh
 * fails, so this wraps createLocalJWKSet instead:
 *  - keys are fresh for the response's Cache-Control max-age (default 1h),
 *  - an unknown kid triggers at most one refetch per 30s cooldown,
 *  - a failed refresh keeps the last good keys for up to 24h, logs an error,
 *    and is retried at most once per cooldown.
 */
export function createVercelJwks(
  jwksUrl: string,
  options: { fetchFn?: Fetch; now?: () => number } = {},
): JWTVerifyGetKey {
  const fetchFn: Fetch =
    options.fetchFn ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let local: ReturnType<typeof createLocalJWKSet> | undefined;
  let fetchedAt = 0;
  let maxAgeMs = DEFAULT_JWKS_MAX_AGE_MS;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | undefined;

  const fetchKeys = async (): Promise<void> => {
    lastAttemptAt = now();
    const response = await fetchFn(jwksUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(`JWKS fetch returned HTTP ${response.status}`);
    }
    const jwks = (await response.json()) as JSONWebKeySet;
    local = createLocalJWKSet(jwks);
    fetchedAt = now();
    maxAgeMs = maxAgeFromCacheControl(response.headers.get("cache-control"));
  };

  // Refreshes the key set, deduplicating concurrent callers. A failed refresh
  // is tolerated while the last good keys are under 24h old.
  const refresh = async (): Promise<void> => {
    pending ??= fetchKeys().finally(() => {
      pending = undefined;
    });
    try {
      await pending;
    } catch (error) {
      if (local && now() - fetchedAt < JWKS_STALE_LIMIT_MS) {
        logger.error(
          "Vercel Marketplace JWKS refresh failed, using cached keys",
          {
            error,
            keysAgeMs: now() - fetchedAt,
          },
        );
        return;
      }
      logger.error("Vercel Marketplace JWKS fetch failed, no usable keys", {
        error,
      });
      throw new VercelJwksUnavailableError();
    }
  };

  const coolingDown = () => now() - lastAttemptAt < JWKS_REFETCH_COOLDOWN_MS;

  const ensureKeys = async (): Promise<void> => {
    const age = now() - fetchedAt;
    if (local && age < maxAgeMs) return;
    if (pending || !coolingDown()) return refresh();
    // A refresh failed moments ago: serve cached keys inside the stale limit
    // rather than refetching on every request.
    if (!local || age >= JWKS_STALE_LIMIT_MS) {
      throw new VercelJwksUnavailableError();
    }
  };

  return async (protectedHeader, token) => {
    await ensureKeys();
    try {
      return await local!(protectedHeader, token);
    } catch (error) {
      if (error instanceof joseErrors.JWKSNoMatchingKey && !coolingDown()) {
        await refresh();
        return local!(protectedHeader, token);
      }
      throw error;
    }
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Verifies a Vercel Marketplace OIDC resource token: RS256 only, exact issuer
 * for our integration, and a single-string aud (the installation id) plus a
 * resource claim. aud is not pinned here because it varies per installation;
 * the caller checks it against the stored installation.
 */
export async function verifyVercelOidcToken(
  token: string,
  options: {
    integrationId: string;
    getKey: JWTVerifyGetKey;
  },
): Promise<VercelOidcClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, options.getKey, {
      issuer: vercelIssuer(options.integrationId),
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["exp", "iat", "aud", "sub"],
    }));
  } catch (error) {
    if (error instanceof VercelJwksUnavailableError) throw error;
    const code =
      error instanceof joseErrors.JOSEError ? error.code : "ERR_UNKNOWN";
    throw new VercelOidcTokenInvalidError(code);
  }

  if (typeof payload.aud !== "string" || payload.aud.length === 0) {
    throw new VercelOidcTokenInvalidError("aud_not_single_string");
  }
  if (typeof payload.resource !== "string" || payload.resource.length === 0) {
    throw new VercelOidcTokenInvalidError("missing_resource");
  }

  return {
    iss: payload.iss as string,
    aud: payload.aud,
    sub: payload.sub as string,
    resource: payload.resource,
    owner: optionalString(payload.owner),
    project: optionalString(payload.project),
    environment: optionalString(payload.environment),
    deployment: optionalString(payload.deployment),
    exp: payload.exp as number,
    iat: payload.iat as number,
  };
}
