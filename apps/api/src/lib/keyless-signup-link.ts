import { randomBytes } from "node:crypto";
import { config } from "../config";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

// Keyless prompts link to signup at firecrawl.dev/k/<id>. The id is random and
// resolves only through `keyless_signup_links`, to the keyless identity and the
// surface that showed it, so the link shows nothing about the caller and the
// warehouse joins a signup (user_onboarding.keyless_ref) to the keyless ledger
// without a secret.
// The bare link is the fallback when no id can be issued; the web route still
// tags the signup keyless, with no surface.
export const KEYLESS_SIGNUP_FALLBACK_URL = "https://firecrawl.dev/k";

export type KeylessSignupSurface = "api" | "mcp" | "cli";

// Crockford base32, lowercase: no i, l, o, u, so a relayed or retyped link
// survives case changes and look-alike characters. 8 chars = 40 random bits.
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH = 8;
export const KEYLESS_SIGNUP_ID_PATTERN = /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/;

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// Issuance runs while building an error response. Past this budget the prompt
// uses the bare link instead of waiting on the database.
const ISSUE_TIMEOUT_MS = 300;
// After a database failure, skip issuance in this process for a short while so
// an outage does not add a timed-out query to every blocked request.
const FAILURE_BACKOFF_MS = 30_000;
let issuanceBackoffUntil = 0;

export function resetKeylessSignupLinkStateForTests(): void {
  issuanceBackoffUntil = 0;
}

export function generateKeylessSignupId(): string {
  // 256 is a multiple of 32, so masking each byte keeps the alphabet uniform.
  let id = "";
  for (const byte of randomBytes(ID_LENGTH)) id += ID_ALPHABET[byte & 31];
  return id;
}

type RequestLike = {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

function lowerString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function firstHeader(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

/**
 * Surface of a keyless prompt, from the same signals as the warehouse
 * `usage_source`: CLI when origin or integration is `cli`, MCP when origin
 * starts with `mcp` or the hosted MCP relayed the request with the proxy
 * secret. Everything else, including requests with no origin, is `api`: the
 * prompt reached the caller as a raw API response, which is what
 * utm_medium=api meant before.
 */
export function keylessSignupSurface(req: RequestLike): KeylessSignupSurface {
  const body =
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>)
      : {};
  // v1 schemas prefault a missing body origin to "api", which would mask an
  // x-origin header, so a bare "api" defers to the header. Classification is
  // case-insensitive, like the warehouse's.
  const bodyOrigin = lowerString(body.origin);
  const headerOrigin = lowerString(firstHeader(req, "x-origin"));
  const origin =
    bodyOrigin && bodyOrigin !== "api"
      ? bodyOrigin
      : (headerOrigin ?? bodyOrigin);
  const integration =
    lowerString(body.integration) ??
    lowerString(firstHeader(req, "x-integration"));
  if (
    config.KEYLESS_PROXY_SECRET &&
    firstHeader(req, "x-firecrawl-keyless-secret") ===
      config.KEYLESS_PROXY_SECRET
  ) {
    return "mcp";
  }
  if (integration === "cli" || origin === "cli") return "cli";
  if (origin?.startsWith("mcp")) return "mcp";
  return "api";
}

const cacheKey = (teamUuid: string, surface: KeylessSignupSurface) =>
  `keyless_signup_link:v1:${teamUuid}:${surface}`;

async function upsertLink(
  teamUuid: string,
  surface: KeylessSignupSurface,
): Promise<string> {
  // A short_id collision (primary key) is a unique violation, not the
  // identity conflict below, so retry it once with a fresh id.
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(schema.keyless_signup_links)
        .values({
          short_id: generateKeylessSignupId(),
          keyless_team_id: teamUuid,
          surface,
        })
        .onConflictDoUpdate({
          target: [
            schema.keyless_signup_links.keyless_team_id,
            schema.keyless_signup_links.surface,
          ],
          // No-op update so RETURNING yields the existing row's short_id.
          set: { keyless_team_id: teamUuid },
        })
        .returning({ short_id: schema.keyless_signup_links.short_id });
      if (!row?.short_id) throw new Error("Upsert returned no row");
      return row.short_id;
    } catch (error) {
      if (attempt >= 1) throw error;
    }
  }
}

async function lookupOrIssue(
  teamUuid: string,
  surface: KeylessSignupSurface,
): Promise<string> {
  const key = cacheKey(teamUuid, surface);
  try {
    const cached = await redisRateLimitClient.get(key);
    if (cached && KEYLESS_SIGNUP_ID_PATTERN.test(cached)) return cached;
  } catch {
    // A cache outage falls through to the idempotent upsert.
  }
  const shortId = await upsertLink(teamUuid, surface);
  try {
    await redisRateLimitClient.set(key, shortId, "EX", CACHE_TTL_SECONDS);
  } catch {
    // The row is the source of truth; the next prompt re-reads it.
  }
  return shortId;
}

/**
 * Short id for this keyless identity and surface, issued once and reused for
 * every later prompt. Returns undefined (never throws) when there is no
 * identity or database, the database fails, or issuance exceeds its budget.
 */
export async function issueKeylessSignupId(
  teamUuid: string | null | undefined,
  surface: KeylessSignupSurface,
): Promise<string | undefined> {
  if (!teamUuid || config.USE_DB_AUTHENTICATION !== true) return undefined;
  if (Date.now() < issuanceBackoffUntil) return undefined;

  let timer: NodeJS.Timeout | undefined;
  const TIMED_OUT = Symbol("timed out");
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ISSUE_TIMEOUT_MS);
  });
  const issued = lookupOrIssue(teamUuid, surface).catch(error => {
    issuanceBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
    logger.warn("Keyless signup link issuance failed", {
      module: "keyless-signup-link",
      surface,
      error,
    });
    return undefined;
  });
  try {
    const result = await Promise.race([issued, timeout]);
    if (result !== TIMED_OUT) return result;
    // A slow database is treated like a failing one, so a stalled query does
    // not pile up behind every blocked request while it recovers.
    issuanceBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
    logger.warn("Keyless signup link issuance timed out", {
      module: "keyless-signup-link",
      surface,
      timeoutMs: ISSUE_TIMEOUT_MS,
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The caller's own signup link, or the bare /k link when none is issued. */
export async function keylessSignupUrl(
  teamUuid: string | null | undefined,
  surface: KeylessSignupSurface,
): Promise<{ url: string; shortId?: string }> {
  const shortId = await issueKeylessSignupId(teamUuid, surface);
  return shortId
    ? { url: `${KEYLESS_SIGNUP_FALLBACK_URL}/${shortId}`, shortId }
    : { url: KEYLESS_SIGNUP_FALLBACK_URL };
}
