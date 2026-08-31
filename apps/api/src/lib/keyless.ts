import { createHash, createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { v5 as uuidv5 } from "uuid";
import { config } from "../config";
import { db } from "../db/connection";
import * as schema from "../db/schema";
import { redisRateLimitClient } from "../services/rate-limiter";
import { isKeylessIpSuspicious } from "./spur";
import { logger } from "./logger";

// Keyless free tier: scrape, search, and interact can be used without an API key
// from the official MCP server, CLI, or SDKs. It's gated per-IP/day by TWO
// limits, both configurable via env: a request count and a credit budget.
// `origin`/`integration` are client-set and spoofable, so they're only a soft
// gate to keep raw API callers on the signup path — the per-IP daily caps plus
// the `keyless/consume` canonical log are the real abuse controls.

// No defaults: the keyless free tier is OFF unless BOTH limits are configured.
const KEYLESS_REQUESTS_PER_DAY = config.KEYLESS_REQUESTS_PER_DAY;
const KEYLESS_CREDITS_PER_DAY = config.KEYLESS_CREDITS_PER_DAY;

// Shared 429 copy for both keyless request-cap and credit-cap failures.
export const KEYLESS_FREE_TIER_LIMIT_MESSAGE = `You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at https://www.firecrawl.dev/signin.

Then authenticate with:
Authorization: Bearer YOUR_API_KEY`;

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

// This value is emitted only on quota exhaustion. It is a versioned, keyed
// pseudonym—not an IP address—so analytics can join the event to the existing
// privacy-controlled signup/OAuth matching pipeline without expanding raw-IP
// logging. Rotation intentionally creates a new cohort namespace.
export const KEYLESS_CONVERSION_COHORT_VERSION = "v1";

// Canonicalizes an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, what Node's
// dual-stack sockets report) to plain IPv4. Every per-IP artifact (quota
// buckets, team ids, Spur cache) must key off this form, or the same client
// counts as two identities.
export function normalizeKeylessIpv4(ip: string): string {
  const trimmed = ip.trim();
  const lower = trimmed.toLowerCase();
  return lower.startsWith("::ffff:") && isIPv4(trimmed.slice(7))
    ? trimmed.slice(7)
    : trimmed;
}

export function keylessConversionCohort(ip: string): string | undefined {
  const secret = config.KEYLESS_CONVERSION_HMAC_SECRET;
  const normalizedIp = normalizeKeylessIpv4(ip);
  if (!secret || !normalizedIp) return undefined;
  return `${KEYLESS_CONVERSION_COHORT_VERSION}:${createHmac("sha256", secret)
    .update(normalizedIp)
    .digest("base64url")}`;
}

export function keylessExhaustionTelemetry(ip: string): Record<string, string> {
  const conversionCohort = keylessConversionCohort(ip);
  return conversionCohort ? { conversionCohort } : {};
}

// Keyless teams reuse the `preview_` prefix so billing (autumn `isPreviewTeam`)
// and GCS persistence are skipped automatically, with a dedicated infix so the
// IP can be recovered when charging credits after a request completes.
const KEYLESS_TEAM_PREFIX = "preview_keyless_";
const KEYLESS_TEAM_PSEUDONYM_PREFIX = "preview_keyless_sha256_";

export function keylessTeamId(ip: string): string {
  return `${KEYLESS_TEAM_PREFIX}${ip}`;
}

function keylessIpFromTeamId(teamId: string): string | null {
  return teamId.startsWith(KEYLESS_TEAM_PREFIX)
    ? teamId.slice(KEYLESS_TEAM_PREFIX.length)
    : null;
}

export function keylessTeamPseudonym(teamId: string): string {
  if (teamId.startsWith(KEYLESS_TEAM_PSEUDONYM_PREFIX)) return teamId;
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !isKeylessIpEligible(ip)) return teamId;
  const digest = createHash("sha256")
    .update(normalizeKeylessIpv4(ip))
    .digest("hex")
    .slice(0, 24);
  return `${KEYLESS_TEAM_PSEUDONYM_PREFIX}${digest}`;
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
  return isIPv4(normalizeKeylessIpv4(ip));
}

const requestsKey = (ip: string) => `keyless_requests:${ip}`;
const creditsKey = (ip: string) => `keyless_credits:${ip}`;

type KeylessQuotaReason = "requests" | "credits";

type KeylessConsumeResult = {
  ok: boolean;
  reason?: KeylessQuotaReason;
  requestsUsed: number;
  creditsUsed: number;
  retryAfterSeconds?: number;
};

function positiveRedisTtl(ttl: number): number | undefined {
  return ttl > 0 ? ttl : undefined;
}

/**
 * Quota denials remain valid when Redis cannot provide the optional TTL hint.
 * Keep that secondary lookup from changing a controlled 429 into a generic
 * authentication failure.
 */
async function retryAfterSecondsFor(key: string): Promise<number | undefined> {
  try {
    return positiveRedisTtl(await redisRateLimitClient.ttl(key));
  } catch {
    return undefined;
  }
}

/** Structured response for projected-credit reservation exhaustion. */
export async function keylessLimitBody(
  teamId: string,
  mode: string,
): Promise<{
  success: false;
  error: string;
  reason: "credits";
  retry_after_seconds?: number;
}> {
  const ip = keylessIpFromTeamId(teamId);
  let retryAfterSeconds: number | undefined;
  try {
    retryAfterSeconds = ip
      ? positiveRedisTtl(await redisRateLimitClient.ttl(creditsKey(ip)))
      : undefined;
  } catch {
    // The reservation already proved the limit; missing TTL must not turn its
    // controlled 429 into a server error.
  }
  logger.warn("Keyless request blocked", {
    canonicalLog: "keyless/consume",
    event: "keyless_exhausted",
    blocked: true,
    reason: "credits",
    mode,
    retryAfterSeconds,
    ...keylessExhaustionTelemetry(ip ?? ""),
  });
  return {
    success: false,
    error: KEYLESS_FREE_TIER_LIMIT_MESSAGE,
    reason: "credits",
    ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
  };
}

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
    return {
      ok: false,
      reason: "requests",
      requestsUsed,
      creditsUsed,
      retryAfterSeconds: await retryAfterSecondsFor(rKey),
    };
  }
  if (creditsUsed >= creditLimit) {
    return {
      ok: false,
      reason: "credits",
      requestsUsed,
      creditsUsed,
      retryAfterSeconds: await retryAfterSecondsFor(creditsKey(ip)),
    };
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
 * consumption). Used by the hosted MCP before a keyless tool call so an
 * ineligible caller receives structured recovery without an OAuth challenge.
 */
export async function checkKeylessEligibility(ip: string): Promise<{
  eligible: boolean;
  reason?:
    | KeylessQuotaReason
    | "disabled"
    | "ineligible_ip"
    | "suspicious"
    | "error";
  retryAfterSeconds?: number;
}> {
  if (!isKeylessConfigured()) return { eligible: false, reason: "disabled" };
  if (!ip || !isKeylessIpEligible(ip)) {
    return { eligible: false, reason: "ineligible_ip" };
  }
  // Key the Spur cache and quota buckets below off the canonical IPv4 form.
  ip = normalizeKeylessIpv4(ip);
  // Optional Spur Context check (only when SPUR_API_KEY is set): treat IPs on
  // anonymizing/rotating infrastructure as ineligible so the hosted MCP can
  // return a bounded recovery result instead of serving a request auth rejects.
  if (await isKeylessIpSuspicious(ip)) {
    return { eligible: false, reason: "suspicious" };
  }
  try {
    const requestsUsed = parseInt(
      (await redisRateLimitClient.get(requestsKey(ip))) ?? "0",
      10,
    );
    if (requestsUsed >= (KEYLESS_REQUESTS_PER_DAY ?? 0)) {
      return {
        eligible: false,
        reason: "requests",
        retryAfterSeconds: await retryAfterSecondsFor(requestsKey(ip)),
      };
    }
    const creditKey = creditsKey(ip);
    const creditsUsed = parseInt(
      (await redisRateLimitClient.get(creditKey)) ?? "0",
      10,
    );
    if (creditsUsed >= (KEYLESS_CREDITS_PER_DAY ?? 0)) {
      return {
        eligible: false,
        reason: "credits",
        retryAfterSeconds: await retryAfterSecondsFor(creditKey),
      };
    }
    return { eligible: true };
  } catch {
    // Limiter store unavailable — fail closed so the MCP returns structured
    // recovery rather than granting unbounded keyless access.
    return { eligible: false, reason: "error" };
  }
}

/**
 * Record a completed keyless request.
 *
 * Billable requests append a row to `keyless_credit_usage`. This table is the
 * only durable store for the raw IP.
 *
 * Zero-credit operations emit a canonical log with a stable SHA-256 pseudonym.
 * The pseudonym supports rate analysis without putting the raw IP in logs. A
 * durable zero-credit row waits for the companion firecrawl-db migration.
 *
 * No-op for non-keyless teams. Best-effort. Never throws.
 */
export async function logKeylessCreditUsage(
  teamId: string,
  credits: number,
): Promise<void> {
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !Number.isFinite(credits)) return;
  const teamUuid = keylessTeamUuid(teamId);
  if (!teamUuid) return;

  // The column records consumption, so a negative reconciliation delta must
  // not land as a negative value.
  const creditsUsed = Math.max(0, Math.ceil(credits));

  // Both branches sit behind the same gate as every other keyless usage
  // record: self-hosted deployments without DB auth track nothing.
  if (config.USE_DB_AUTHENTICATION !== true) return;

  if (creditsUsed <= 0) {
    const teamPseudonym = keylessTeamPseudonym(teamId);
    logger.info("Keyless zero-credit usage", {
      canonicalLog: "keyless/usage",
      teamId: teamPseudonym,
      creditsUsed: 0,
    });
    return;
  }

  try {
    await db.insert(schema.keyless_credit_usage).values({
      team_id: teamUuid,
      ip,
      credits_used: creditsUsed,
    });
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Add the actual credits a completed request consumed to the IP's daily credit
 * counter, and record the request in `keyless_credit_usage`. The counter is only
 * touched for positive credits, so a zero-credit operation becomes observable
 * without drawing down any budget. No-op for non-keyless teams. Best-effort;
 * never throws. Used by the worker for the non-reserved path; the controllers
 * reserve up front and call `logKeylessCreditUsage` directly at reconciliation.
 */
export async function chargeKeylessCredits(
  teamId: string,
  credits: number,
): Promise<void> {
  const ip = keylessIpFromTeamId(teamId);
  if (!ip || !Number.isFinite(credits)) return;

  if (credits > 0) {
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
  }

  // Log the usage to keyless_credit_usage for abuse monitoring. Best-effort.
  await logKeylessCreditUsage(teamId, credits);
}
