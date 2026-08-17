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
// API call per month. The integration is entirely optional: with no key set the
// keyless tier behaves exactly as before.
//
// Failure policy. A lookup that is attempted but produces no verdict (timeout,
// non-2xx, transport error) fails open by default — the request is allowed — so
// a Spur outage can't take down the free tier. Call sites may opt in to failing
// closed instead, which additionally requires SPUR_RESEARCH_FAIL_CLOSED; see
// isKeylessIpSuspicious. A missing SPUR_API_KEY is never a "failure": Spur is
// simply not in use and every IP passes.

const SPUR_API_BASE = "https://api.spur.us/v2/context";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// The lookup runs inline on the keyless auth path, before any quota is
// consumed, so it must never be able to hold a request open. Spur's Context API
// answers in tens of milliseconds; a few seconds is generous headroom and still
// a bounded wait for the caller.
const LOOKUP_TIMEOUT_MS = 3000;
const cacheKey = (ip: string) => `spur_context:${ip}`;

// Subset of the Spur IP Context Object we read. See the API docs for the full
// shape; everything here is optional because Spur omits empty fields.
type SpurContext = {
  ip?: string;
  infrastructure?: string;
  risks?: string[];
  tunnels?: { anonymous?: boolean; operator?: string; type?: string }[];
  client?: { behaviors?: string[]; proxies?: string[] };
};

// Why a lookup produced no verdict. Kept separate from "not configured" because
// the two demand opposite handling: an unconfigured integration must always
// pass, whereas a configured-but-broken one is exactly the case fail-closed
// exists for. "timeout" is broken out from the rest so a slow Spur is
// distinguishable from a rejecting or unreachable one in logs.
type SpurLookupFailure = "timeout" | "transport" | "status" | "malformed";

type SpurLookupResult =
  | { status: "not_configured" }
  | { status: "ok"; ctx: SpurContext }
  | { status: "failed"; failure: SpurLookupFailure };

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

// AbortSignal.timeout rejects with a DOMException named "TimeoutError"; a
// caller-side abort surfaces as "AbortError". Either way the budget ran out
// rather than Spur answering.
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

async function fetchContext(ip: string): Promise<SpurLookupResult> {
  // Cache miss → hit the real Spur API. Logged so we can track real spend.
  logger.info("Spur Context API request (cache miss)", {
    canonicalLog: "spur/lookup",
    ip,
  });

  let response: Response;
  try {
    response = await fetch(`${SPUR_API_BASE}/${encodeURIComponent(ip)}`, {
      method: "GET",
      headers: { Token: config.SPUR_API_KEY! },
      // Bound the wait: this blocks keyless auth.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (error) {
    const failure: SpurLookupFailure = isTimeout(error)
      ? "timeout"
      : "transport";
    logger.warn("Spur Context API request errored", {
      canonicalLog: "spur/lookup",
      ip,
      failure,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      error,
    });
    return { status: "failed", failure };
  }

  if (!response.ok) {
    // Includes 401 (bad/expired token) and 429 (Spur's own rate limit) — both
    // of which a burst of fresh IPs can trigger at exactly the wrong moment.
    logger.warn("Spur Context API request failed", {
      canonicalLog: "spur/lookup",
      ip,
      failure: "status",
      status: response.status,
    });
    return { status: "failed", failure: "status" };
  }

  try {
    return { status: "ok", ctx: (await response.json()) as SpurContext };
  } catch (error) {
    logger.warn("Spur Context API response was not valid JSON", {
      canonicalLog: "spur/lookup",
      ip,
      failure: "malformed",
      error,
    });
    return { status: "failed", failure: "malformed" };
  }
}

/**
 * Look up an IP's Spur context, preferring the 30-day Redis cache and only
 * caching successful (non-error) responses. Distinguishes "Spur isn't
 * configured" from "the lookup failed" so callers can apply different failure
 * policies to the two.
 */
async function lookupSpurContext(ip: string): Promise<SpurLookupResult> {
  if (!isSpurEnabled()) return { status: "not_configured" };

  const cached = await getCachedContext(ip);
  if (cached) return { status: "ok", ctx: cached };

  const result = await fetchContext(ip);
  // Only cache non-error responses.
  if (result.status === "ok") await cacheContext(ip, result.ctx);
  return result;
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
 * anonymizing/rotating infrastructure.
 *
 * Always false when Spur is not configured (no SPUR_API_KEY) — the check simply
 * isn't in use, so self-hosted and unconfigured deployments are unaffected no
 * matter how the flags are set.
 *
 * When Spur *is* configured but the lookup produces no verdict, the default is
 * to fail open so a Spur outage never breaks keyless. `options.failClosed`
 * marks a call site as one where that failure may reject instead; it only takes
 * effect when SPUR_RESEARCH_FAIL_CLOSED is also on, so the behaviour stays
 * opt-in per deployment as well as per surface.
 */
export async function isKeylessIpSuspicious(
  ip: string,
  options: { failClosed?: boolean } = {},
): Promise<boolean> {
  const result = await lookupSpurContext(ip);

  // Spur not in use — nothing to say about this IP.
  if (result.status === "not_configured") return false;

  if (result.status === "failed") {
    const failClosed =
      options.failClosed === true && config.SPUR_RESEARCH_FAIL_CLOSED;
    logger.warn("Spur lookup produced no verdict", {
      canonicalLog: "spur/lookup",
      ip,
      failure: result.failure,
      // Distinguishes a fail-closed rejection from a genuine proxy verdict when
      // reading back why a keyless request was refused.
      reason: "lookup_failed",
      failClosed,
    });
    return failClosed;
  }

  const ctx = result.ctx;
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
