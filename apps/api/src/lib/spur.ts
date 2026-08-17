import { randomUUID } from "crypto";
import { config } from "../config";
import { logger } from "./logger";
import { redisRateLimitClient } from "../services/rate-limiter";

// Optional Spur Context API integration for the keyless free tier. When
// SPUR_API_KEY is set, the IP behind every keyless request is looked up against
// Spur's IP-context database (https://docs.spur.us/context-api). IPs fronting
// anonymizing/rotating infrastructure — VPN/proxy/TOR tunnels or residential
// proxy networks — are the cheapest way to defeat the per-IP keyless caps, so we
// refuse keyless for them and steer the caller to sign up for an API key.
//
// Lookups are cached in Redis for 30 days so a given IP costs at most one Spur
// API call per month. Concurrent misses for the same IP are collapsed with a
// Redis single-flight lock so a burst from one IP triggers a single upstream
// call — the loser callers briefly wait for that result instead of each hitting
// Spur. The integration is entirely optional: with no key set the keyless tier
// behaves exactly as before, and any Spur error (timeout, lock failure, outage)
// fails open — the request is allowed — so Spur can never take down the free tier.

const SPUR_API_BASE = "https://api.spur.us/v2/context";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const cacheKey = (ip: string) => `spur_context:${ip}`;

// Everything below is bounded so a request can never get stuck on the upstream
// call, on holding the lock, or on waiting for another request's result.
//
// - FETCH_TIMEOUT_MS aborts the Spur HTTP call.
// - LOCK_TTL_MS is the single-flight lock's auto-expiry; it sits ~1s above the
//   fetch timeout (headroom for the surrounding Redis round-trips) so the winner
//   isn't preempted mid-fetch, and it caps how long a dead winner can block
//   others (Redis expires the lock even if the process crashes before releasing).
// - LOCK_WAIT_MS caps how long a loser waits for the winner's result before
//   failing open; POLL_INTERVAL_MS is how often it re-checks the result cache.
const FETCH_TIMEOUT_MS = 5000;
const LOCK_TTL_MS = FETCH_TIMEOUT_MS + 1000;
const LOCK_WAIT_MS = LOCK_TTL_MS;
const POLL_INTERVAL_MS = 200;
const lockKey = (ip: string) => `spur_lock:${ip}`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Subset of the Spur IP Context Object we read. See the API docs for the full
// shape; everything here is optional because Spur omits empty fields.
type SpurContext = {
  ip?: string;
  infrastructure?: string;
  risks?: string[];
  tunnels?: { anonymous?: boolean; operator?: string; type?: string }[];
  client?: { behaviors?: string[]; proxies?: string[] };
};

function isSpurEnabled(): boolean {
  return (
    typeof config.SPUR_API_KEY === "string" && config.SPUR_API_KEY.length > 0
  );
}

async function getCachedContext(ip: string): Promise<SpurContext | null> {
  try {
    const raw = await redisRateLimitClient.get(cacheKey(ip));
    return raw ? (JSON.parse(raw) as SpurContext) : null;
  } catch (error) {
    // Cache read failed (store down or corrupt value) — treat as a miss.
    logger.warn("Failed to read Spur context from cache", {
      canonicalLog: "spur/lookup",
      ip,
      error,
    });
    return null;
  }
}

async function cacheContext(ip: string, ctx: SpurContext): Promise<void> {
  try {
    await redisRateLimitClient.set(
      cacheKey(ip),
      JSON.stringify(ctx),
      "EX",
      CACHE_TTL_SECONDS,
    );
  } catch (error) {
    // Best-effort: a failed cache write just means we look the IP up again.
    logger.warn("Failed to cache Spur context", {
      canonicalLog: "spur/lookup",
      ip,
      error,
    });
  }
}

// Compact summary of a context for logs — never dump the full object.
function summarize(ctx: SpurContext) {
  return {
    infrastructure: ctx.infrastructure,
    risks: ctx.risks,
    tunnels: ctx.tunnels?.map(t => t.type),
    proxies: ctx.client?.proxies,
  };
}

async function fetchContext(ip: string): Promise<SpurContext | null> {
  // Cache miss → hit the real Spur API. Logged so we can track real spend.
  // The request is bounded by FETCH_TIMEOUT_MS; an abort throws and the caller
  // fails open.
  logger.info("Spur Context API request (cache miss)", {
    canonicalLog: "spur/lookup",
    ip,
  });
  const response = await fetch(`${SPUR_API_BASE}/${encodeURIComponent(ip)}`, {
    method: "GET",
    headers: { Token: config.SPUR_API_KEY! },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    logger.warn("Spur Context API request failed", {
      canonicalLog: "spur/lookup",
      ip,
      status: response.status,
    });
    return null;
  }
  const ctx = (await response.json()) as SpurContext;
  logger.info("Spur Context API response", {
    canonicalLog: "spur/lookup",
    ip,
    ...summarize(ctx),
  });
  return ctx;
}

// Single-flight lock: the winner (returns a token) is the only caller that hits
// Spur for this IP; everyone else waits for its cached result. `null` means we
// lost the race. Redis errors propagate so the caller fails open rather than
// waiting on a lock we never held.
async function acquireLock(ip: string): Promise<string | null> {
  const token = randomUUID();
  const result = await redisRateLimitClient.set(
    lockKey(ip),
    token,
    "PX",
    LOCK_TTL_MS,
    "NX",
  );
  return result === "OK" ? token : null;
}

// Atomic compare-and-delete so we only ever clear our own lock — a plain
// get-then-del could delete a successor's lock if our lease expired in between.
// Best-effort: failures are swallowed since the PX TTL frees the lock regardless.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

async function releaseLock(ip: string, token: string): Promise<void> {
  try {
    await redisRateLimitClient.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(ip), token);
  } catch (error) {
    logger.warn("Failed to release Spur single-flight lock", {
      canonicalLog: "spur/lookup",
      ip,
      error,
    });
  }
}

// Loser path: poll for the winner's cached result every POLL_INTERVAL_MS,
// bounded by LOCK_WAIT_MS. If the result never lands (winner failed or is still
// running at the deadline), give up and fail open.
async function waitForResult(ip: string): Promise<SpurContext | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    // Clamp the last sleep to the remaining budget so we never overshoot the
    // LOCK_WAIT_MS ceiling.
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    const cached = await getCachedContext(ip);
    if (cached) return cached;
  }
  return null;
}

/**
 * Look up an IP's Spur context, preferring the 30-day Redis cache and only
 * caching successful (non-error) responses. Concurrent misses for the same IP
 * are collapsed via a Redis single-flight lock: one caller fetches, the rest
 * wait (bounded) for its result. Returns null when Spur is disabled or anything
 * goes wrong (lock error, timeout, upstream failure) — callers then fail open
 * (treat the IP as not suspicious). Every wait here is bounded, so a request can
 * never get stuck on the lock or on another request's in-flight lookup.
 */
async function getSpurContext(ip: string): Promise<SpurContext | null> {
  if (!isSpurEnabled()) return null;

  const cached = await getCachedContext(ip);
  if (cached) return cached;

  try {
    const token = await acquireLock(ip);
    if (!token) {
      // Lost the race → a lookup for this IP is already in flight. Wait for its
      // result instead of making our own call. Logged so we can measure how many
      // Spur calls the single-flight coalescing saves (savedApiCall === true).
      const result = await waitForResult(ip);
      logger.info("Spur lookup coalesced by single-flight", {
        canonicalLog: "spur/lookup",
        ip,
        savedApiCall: result !== null,
      });
      return result;
    }

    try {
      // Another winner may have populated the cache between our miss and
      // winning the lock — re-check before spending a Spur call.
      const fresh = await getCachedContext(ip);
      if (fresh) return fresh;

      const ctx = await fetchContext(ip);
      // Only cache non-error responses.
      if (ctx) await cacheContext(ip, ctx);
      return ctx;
    } finally {
      await releaseLock(ip, token);
    }
  } catch (error) {
    // Lock error, fetch timeout/abort, or any upstream failure → fail open.
    // AbortSignal.timeout rejects with a TimeoutError; flag it so the timeout
    // rate is countable separately from other failures.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    logger.warn("Spur context lookup failed; failing open", {
      canonicalLog: "spur/lookup",
      ip,
      timedOut,
      error,
    });
    return null;
  }
}

// Risk flags that, on their own, mark an IP as fronting proxy/tunnel
// infrastructure. Plain DATACENTER or GEO_MISMATCH signals are intentionally
// NOT treated as suspicious — many legitimate clients hit a free tier from
// cloud/CGNAT, and the per-IP caps already cover those.
const SUSPICIOUS_RISKS = new Set(["CALLBACK_PROXY", "TUNNEL"]);

function isSuspiciousContext(ctx: SpurContext): boolean {
  // A live VPN/proxy/TOR tunnel — the canonical IP-rotation vector.
  if (Array.isArray(ctx.tunnels) && ctx.tunnels.length > 0) return true;
  // Residential / rotating proxy networks observed exiting this IP.
  if (Array.isArray(ctx.client?.proxies) && ctx.client.proxies.length > 0) {
    return true;
  }
  // Explicit proxy/tunnel risk flags.
  if (
    Array.isArray(ctx.risks) &&
    ctx.risks.some(r => SUSPICIOUS_RISKS.has(r))
  ) {
    return true;
  }
  return false;
}

/**
 * Whether the keyless tier should refuse this IP because Spur flags it as
 * anonymizing/rotating infrastructure. No-op (false) when Spur is disabled, and
 * fails open (false) on any lookup error so a Spur outage never breaks keyless.
 */
export async function isKeylessIpSuspicious(ip: string): Promise<boolean> {
  if (!isSpurEnabled()) return false;

  const ctx = await getSpurContext(ip);
  if (!ctx) return false;

  const suspicious = isSuspiciousContext(ctx);
  if (suspicious) {
    logger.info("Keyless IP flagged suspicious by Spur", {
      canonicalLog: "spur/lookup",
      ip,
      suspicious: true,
      tunnels: ctx.tunnels?.map(t => t.type),
      proxies: ctx.client?.proxies,
      risks: ctx.risks,
    });
  }
  return suspicious;
}
