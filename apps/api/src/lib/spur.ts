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
// keyless tier behaves exactly as before, and any Spur error fails open (the
// request is allowed) so a Spur outage can't take down the free tier.

const SPUR_API_BASE = "https://api.spur.us/v2/context";
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
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

async function fetchContext(ip: string): Promise<SpurContext | null> {
  // Cache miss → hit the real Spur API. Logged so we can track real spend.
  logger.info("Spur Context API request (cache miss)", {
    canonicalLog: "spur/lookup",
    ip,
  });
  const response = await fetch(`${SPUR_API_BASE}/${encodeURIComponent(ip)}`, {
    method: "GET",
    headers: { Token: config.SPUR_API_KEY! },
  });
  if (!response.ok) {
    logger.warn("Spur Context API request failed", {
      canonicalLog: "spur/lookup",
      ip,
      status: response.status,
    });
    return null;
  }
  return (await response.json()) as SpurContext;
}

/**
 * Look up an IP's Spur context, preferring the 30-day Redis cache and only
 * caching successful (non-error) responses. Returns null when Spur is disabled
 * or the lookup fails — callers then fail open (treat the IP as not suspicious).
 */
async function getSpurContext(ip: string): Promise<SpurContext | null> {
  if (!isSpurEnabled()) return null;

  const cached = await getCachedContext(ip);
  if (cached) return cached;

  let ctx: SpurContext | null;
  try {
    ctx = await fetchContext(ip);
  } catch (error) {
    logger.warn("Spur Context API request errored", {
      canonicalLog: "spur/lookup",
      ip,
      error,
    });
    return null;
  }

  // Only cache non-error responses.
  if (ctx) await cacheContext(ip, ctx);
  return ctx;
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
