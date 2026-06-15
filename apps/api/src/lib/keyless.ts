import { isIPv4 } from "node:net";
import { v5 as uuidv5 } from "uuid";
import { config } from "../config";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { redisRateLimitClient } from "../services/rate-limiter";

// Keyless free tier: scrape, search, and interact can be used without an API key
// from the official MCP server, CLI, or SDKs. It's gated per-IP/day by TWO
// limits, both configurable via env: a request count and a credit budget.
// `origin`/`integration` are client-set and spoofable, so they're only a soft
// gate to keep raw API callers on the signup path — the per-IP daily caps plus
// the `keyless/consume` canonical log are the real abuse controls.

// No defaults: the keyless free tier is OFF unless BOTH limits are configured.
export const KEYLESS_REQUESTS_PER_DAY = config.KEYLESS_REQUESTS_PER_DAY;
export const KEYLESS_CREDITS_PER_DAY = config.KEYLESS_CREDITS_PER_DAY;

// The tier is "configured" when BOTH limits are set — even to 0. Unset means the
// feature is off (callers get a plain Unauthorized); 0 means it's on but the
// budget is exhausted (callers get the 429 cap message).
export function isKeylessConfigured(): boolean {
  return (
    typeof KEYLESS_REQUESTS_PER_DAY === "number" &&
    typeof KEYLESS_CREDITS_PER_DAY === "number"
  );
}

const DAY_SECONDS = 86400;

// Keyless teams reuse the `preview_` prefix so billing (autumn `isPreviewTeam`)
// and GCS persistence are skipped automatically, with a dedicated infix so the
// IP can be recovered when charging credits after a request completes.
export const KEYLESS_TEAM_PREFIX = "preview_keyless_";

export function keylessTeamId(ip: string): string {
  return `${KEYLESS_TEAM_PREFIX}${ip}`;
}

export function keylessIpFromTeamId(teamId: string): string | null {
  return teamId.startsWith(KEYLESS_TEAM_PREFIX)
    ? teamId.slice(KEYLESS_TEAM_PREFIX.length)
    : null;
}

// Fixed namespace for deriving a stable per-keyless-team UUID. Tables like
// `scrapes` require a UUID team_id, but keyless teams are `preview_keyless_<ip>`
// strings. Mapping each to a deterministic UUIDv5 keeps rows per-IP-distinct
// (so ownership checks such as interact still isolate keyless users) while
// satisfying the UUID column — unlike the shared preview placeholder.
const KEYLESS_TEAM_UUID_NAMESPACE = "9e6c8f2a-3b1d-4c7e-8a5f-2d4b6e8c0a1f";

/**
 * Deterministic UUID for a keyless team's persisted rows, or null for
 * non-keyless teams (callers then fall back to the raw/placeholder team_id).
 */
export function keylessTeamUuid(
  teamId: string | null | undefined,
): string | null {
  if (!teamId || !teamId.startsWith(KEYLESS_TEAM_PREFIX)) return null;
  return uuidv5(teamId, KEYLESS_TEAM_UUID_NAMESPACE);
}

/**
 * Keyless is allowed only for a *valid IPv4* client identity. This both:
 *  - denies IPv6 (a single client controls a huge block — a /64 is ~18
 *    quintillion addresses — so a per-IP cap is trivially bypassed), and
 *  - rejects malformed/unknown values (e.g. a forwarded `x-firecrawl-keyless-ip`
 *    that isn't a real IP), so they can't be used to mint arbitrary buckets and
 *    weaken per-IP quota enforcement.
 * IPv4-mapped IPv6 (e.g. "::ffff:1.2.3.4", how dual-stack sockets surface IPv4)
 * is treated as IPv4.
 */
export function isKeylessIpEligible(ip: string): boolean {
  const normalized = ip.startsWith("::ffff:")
    ? ip.slice("::ffff:".length)
    : ip;
  return isIPv4(normalized);
}

const requestsKey = (ip: string) => `keyless_requests:${ip}`;
const creditsKey = (ip: string) => `keyless_credits:${ip}`;

export type KeylessConsumeResult = {
  ok: boolean;
  reason?: "requests" | "credits";
  requestsUsed: number;
  creditsUsed: number;
};

/**
 * Consume one request from the per-IP daily request budget and check the credit
 * budget (credits are charged after the request completes, in
 * `chargeKeylessCredits`). Returns whether the request may proceed.
 */
export async function consumeKeylessRequest(
  ip: string,
): Promise<KeylessConsumeResult> {
  const requestLimit = KEYLESS_REQUESTS_PER_DAY ?? 0;
  const creditLimit = KEYLESS_CREDITS_PER_DAY ?? 0;

  const rKey = requestsKey(ip);
  const requestsUsed = await redisRateLimitClient.incr(rKey);
  if (requestsUsed === 1) {
    await redisRateLimitClient.expire(rKey, DAY_SECONDS);
  }

  const creditsUsed = parseInt(
    (await redisRateLimitClient.get(creditsKey(ip))) ?? "0",
    10,
  );

  if (requestsUsed > requestLimit) {
    return { ok: false, reason: "requests", requestsUsed, creditsUsed };
  }
  if (creditsUsed >= creditLimit) {
    return { ok: false, reason: "credits", requestsUsed, creditsUsed };
  }
  return { ok: true, requestsUsed, creditsUsed };
}

/**
 * Read-only check of whether an IP could currently use the keyless tier (no
 * consumption). Used by the hosted MCP to decide, at connect time, whether to
 * serve keyless (eligible) or throw so FastMCP emits the OAuth challenge (not).
 */
export async function checkKeylessEligibility(
  ip: string,
): Promise<{ eligible: boolean; reason?: string }> {
  if (!isKeylessConfigured()) return { eligible: false, reason: "disabled" };
  if (!ip || !isKeylessIpEligible(ip)) {
    return { eligible: false, reason: "ineligible_ip" };
  }
  try {
    const requestsUsed = parseInt(
      (await redisRateLimitClient.get(requestsKey(ip))) ?? "0",
      10,
    );
    if (requestsUsed >= (KEYLESS_REQUESTS_PER_DAY ?? 0)) {
      return { eligible: false, reason: "requests" };
    }
    const creditsUsed = parseInt(
      (await redisRateLimitClient.get(creditsKey(ip))) ?? "0",
      10,
    );
    if (creditsUsed >= (KEYLESS_CREDITS_PER_DAY ?? 0)) {
      return { eligible: false, reason: "credits" };
    }
    return { eligible: true };
  } catch {
    // Limiter store unavailable — fail closed so the MCP issues an OAuth
    // challenge rather than granting unbounded keyless.
    return { eligible: false, reason: "error" };
  }
}

/**
 * Add the actual credits a completed request consumed to the IP's daily credit
 * counter. No-op for non-keyless teams. Best-effort; never throws.
 */
export async function chargeKeylessCredits(
  teamId: string,
  credits: number,
): Promise<void> {
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !Number.isFinite(credits) || credits <= 0) return;
  const inc = Math.ceil(credits);
  try {
    const key = creditsKey(ip);
    const total = await redisRateLimitClient.incrby(key, inc);
    if (total === inc) {
      await redisRateLimitClient.expire(key, DAY_SECONDS);
    }
  } catch {
    // Counter is best-effort; a missed charge just means the IP gets a few
    // extra free credits today.
  }

  // Log the usage to keyless_credit_usage (per-IP keyless team UUID + raw IP)
  // for abuse monitoring. Best-effort — never block the request.
  const teamUuid = keylessTeamUuid(teamId);
  if (config.USE_DB_AUTHENTICATION === true && teamUuid) {
    try {
      await db.insert(schema.keyless_credit_usage).values({
        team_id: teamUuid,
        ip,
        credits_used: inc,
      });
    } catch {
      // Logging is best-effort.
    }
  }
}
