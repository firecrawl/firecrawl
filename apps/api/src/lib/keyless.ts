import { isIPv4 } from "node:net";
import { v5 as uuidv5 } from "uuid";
import { config } from "../config";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { redisRateLimitClient } from "../services/rate-limiter";
import { isKeylessIpSuspicious } from "./spur";

// Keyless free tier: scrape, search, and interact can be used without an API key
// from the official MCP server, CLI, or SDKs. It's gated per-IP/day by TWO
// limits, both configurable via env: a request count and a credit budget.
// `origin`/`integration` are client-set and spoofable, so they're only a soft
// gate to keep raw API callers on the signup path — the per-IP daily caps plus
// the `keyless/consume` canonical log are the real abuse controls.

// No defaults: the keyless free tier is OFF unless BOTH limits are configured.
const KEYLESS_REQUESTS_PER_DAY = config.KEYLESS_REQUESTS_PER_DAY;
const KEYLESS_CREDITS_PER_DAY = config.KEYLESS_CREDITS_PER_DAY;

export const KEYLESS_CREDITS_MESSAGE = `You've reached today's limit of free, unauthenticated credits for Firecrawl. Sign up for a free API key at https://firecrawl.dev for 1000 more credits and higher rate limits for free. (If you're an agent, you can also use https://firecrawl.dev/auth.md)`;

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
const KEYLESS_TEAM_PREFIX = "preview_keyless_";

export function keylessTeamId(ip: string): string {
  return `${KEYLESS_TEAM_PREFIX}${ip}`;
}

function keylessIpFromTeamId(teamId: string): string | null {
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
  const normalized = ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
  return isIPv4(normalized);
}

const requestsKey = (ip: string) => `keyless_requests:${ip}`;
const creditsKey = (ip: string) => `keyless_credits:${ip}`;

type KeylessConsumeResult = {
  ok: boolean;
  reason?: "requests" | "credits";
  requestsUsed: number;
  creditsUsed: number;
};

type KeylessCreditReservationResult = {
  ok: boolean;
  creditsUsed: number;
  limit: number;
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
 * Atomically reserve projected credits from the keyless per-IP daily credit
 * budget. No-op for non-keyless teams.
 */
export async function reserveKeylessCredits(
  teamId: string,
  projectedCredits: number,
): Promise<KeylessCreditReservationResult> {
  const ip = keylessIpFromTeamId(teamId);
  const limit = KEYLESS_CREDITS_PER_DAY ?? 0;
  if (!ip || !Number.isFinite(projectedCredits) || projectedCredits <= 0) {
    return { ok: true, creditsUsed: 0, limit };
  }

  const projected = Math.ceil(projectedCredits);
  const key = creditsKey(ip);
  const result = (await redisRateLimitClient.eval(
    `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local projected = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if current + projected > limit then
  return {0, current}
end
local total = redis.call("INCRBY", KEYS[1], projected)
if total == projected then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return {1, total}
`,
    1,
    key,
    projected,
    limit,
    DAY_SECONDS,
  )) as [number, number];

  return {
    ok: result[0] === 1,
    creditsUsed: Number(result[1] ?? 0),
    limit,
  };
}

/**
 * Reconcile a prior keyless reservation to actual credits. Delta may be
 * negative; the counter is clamped at zero to tolerate retries or races.
 */
export async function adjustKeylessCredits(
  teamId: string,
  deltaCredits: number,
): Promise<number | null> {
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !Number.isFinite(deltaCredits) || deltaCredits === 0) return null;

  const delta =
    deltaCredits > 0
      ? Math.ceil(deltaCredits)
      : -Math.ceil(Math.abs(deltaCredits));
  const key = creditsKey(ip);
  const total = (await redisRateLimitClient.eval(
    `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local delta = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local next = current + delta
if next < 0 then
  next = 0
end
redis.call("SET", KEYS[1], next, "EX", ttl)
return next
`,
    1,
    key,
    delta,
    DAY_SECONDS,
  )) as number;

  return Number(total);
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
  // Optional Spur Context check (only when SPUR_API_KEY is set): treat IPs on
  // anonymizing/rotating infrastructure as ineligible so the hosted MCP issues
  // an OAuth challenge instead of serving keyless that auth would then reject.
  if (await isKeylessIpSuspicious(ip)) {
    return { eligible: false, reason: "suspicious" };
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
 * Append a row to `keyless_credit_usage` recording the actual credits a completed
 * keyless request consumed (per-IP keyless team UUID + raw IP), for abuse
 * monitoring. No-op for non-keyless teams, non-positive credits, or when DB auth
 * is off. Best-effort — never throws.
 */
export async function logKeylessCreditUsage(
  teamId: string,
  credits: number,
): Promise<void> {
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !Number.isFinite(credits) || credits <= 0) return;
  const teamUuid = keylessTeamUuid(teamId);
  if (config.USE_DB_AUTHENTICATION !== true || !teamUuid) return;
  try {
    await db.insert(schema.keyless_credit_usage).values({
      team_id: teamUuid,
      ip,
      credits_used: Math.ceil(credits),
    });
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Add the actual credits a completed request consumed to the IP's daily credit
 * counter. No-op for non-keyless teams. Best-effort; never throws. Used by the
 * worker for the non-reserved path; the controllers reserve up front and call
 * `logKeylessCreditUsage` directly at reconciliation.
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

  // Log the usage to keyless_credit_usage for abuse monitoring. Best-effort.
  await logKeylessCreditUsage(teamId, credits);
}
