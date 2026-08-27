/**
 * Spur Context API (https://docs.spur.us/context-api) check for the keyless
 * free tier. When SPUR_API_KEY is set, the IPv4 behind a keyless request is
 * looked up and IPs fronting anonymizing infrastructure (VPN/proxy/TOR
 * tunnels, residential proxy networks) are refused keyless access.
 *
 * Spur bills per lookup, so an IP costs at most one upstream call per cache
 * window regardless of outcome: results and failures are cached in Redis and
 * concurrent callers for one IP coalesce behind a lock. Every error fails
 * open (not suspicious) so Spur can never take down the free tier.
 */
import { randomUUID } from "crypto";
import { isIPv4 } from "net";
import { config } from "../config";
import { redisRateLimitClient } from "../services/rate-limiter";
import { logger } from "./logger";

const FETCH_TIMEOUT_MS = 5000;
// Headroom over the fetch timeout for the Redis round-trips around it.
const LOCK_TTL_MS = FETCH_TIMEOUT_MS + 1000;
const LOCK_WAIT_MS = LOCK_TTL_MS;
const LOCK_POLL_MS = 200;
const CONTEXT_TTL_SEC = 30 * 24 * 60 * 60;
const FAILED_TTL_SEC = 10 * 60;

const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

type SpurContext = {
  infrastructure?: string;
  risks: string[];
  tunnels: { anonymous?: boolean; operator?: string; type?: string }[];
  client: { proxies: string[] };
};

type CacheState =
  | { state: "hit"; ctx: SpurContext }
  | { state: "failed" }
  | { state: "miss" };

const contextKey = (ip: string) => `spur_context:${ip}`;
const failedKey = (ip: string) => `spur_context_failed:${ip}`;
const lockKey = (ip: string) => `spur_lock:${ip}`;

const meta = (ip: string) => ({ canonicalLog: "spur/lookup", ip });

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function summarize(ctx: SpurContext) {
  return {
    infrastructure: ctx.infrastructure,
    risks: ctx.risks,
    tunnels: ctx.tunnels.map(t => t.type),
    proxies: ctx.client.proxies,
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === "string") : [];

const objects = <T>(v: unknown): T[] =>
  Array.isArray(v) ? v.filter(x => x && typeof x === "object") : [];

// Both Redis and Spur feed this; the verdict code must never see an
// unvalidated shape, since a throw here would fail the request closed.
function toContext(raw: unknown): SpurContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const client = r.client as Record<string, unknown> | undefined;
  return {
    infrastructure:
      typeof r.infrastructure === "string" ? r.infrastructure : undefined,
    risks: strings(r.risks),
    tunnels: objects(r.tunnels),
    client: { proxies: strings(client?.proxies) },
  };
}

// Only IP-rotation infrastructure counts. DATACENTER, GEO_MISMATCH and
// non-anonymous tunnels (enterprise VPN, ZTNA) are legit developer traffic.
function isSuspicious(ctx: SpurContext): boolean {
  return (
    ctx.tunnels.some(t => t.anonymous === true) ||
    ctx.client.proxies.length > 0 ||
    ctx.risks.includes("CALLBACK_PROXY") ||
    ctx.risks.includes("TUNNEL")
  );
}

function verdict(ip: string, ctx: SpurContext | null): boolean {
  if (!ctx || !isSuspicious(ctx)) return false;
  logger.info("Keyless IP flagged suspicious by Spur", {
    ...meta(ip),
    suspicious: true,
    ...summarize(ctx),
  });
  return true;
}

// Verdict for a cache entry that is not a miss: a failure marker fails open.
function cachedVerdict(ip: string, cached: CacheState): boolean {
  return verdict(ip, cached.state === "hit" ? cached.ctx : null);
}

function parseContext(raw: string | null): SpurContext | null {
  if (raw === null) return null;
  try {
    return toContext(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readCache(ip: string): Promise<CacheState> {
  let raw: string | null;
  let failed: string | null;
  try {
    [raw, failed] = await redisRateLimitClient.mget(
      contextKey(ip),
      failedKey(ip),
    );
  } catch (error) {
    logger.warn("Spur cache read failed", { ...meta(ip), error });
    return { state: "miss" };
  }
  const ctx = parseContext(raw);
  if (ctx) return { state: "hit", ctx };
  if (failed !== null) return { state: "failed" };
  return { state: "miss" };
}

async function writeCache(
  ip: string,
  key: string,
  value: string,
  ttlSec: number,
) {
  try {
    await redisRateLimitClient.set(key, value, "EX", ttlSec);
  } catch (error) {
    logger.warn("Spur cache write failed", { ...meta(ip), key, error });
  }
}

async function releaseLock(ip: string, token: string) {
  try {
    await redisRateLimitClient.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(ip), token);
  } catch (error) {
    logger.warn("Spur lock release failed", { ...meta(ip), error });
  }
}

async function fetchContext(
  ip: string,
  apiKey: string,
): Promise<SpurContext | null> {
  logger.info("Spur Context API request (cache miss)", meta(ip));
  const res = await fetch(
    `https://api.spur.us/v2/context/${encodeURIComponent(ip)}`,
    {
      headers: { Token: apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    logger.warn("Spur Context API request failed", {
      ...meta(ip),
      status: res.status,
    });
    return null;
  }
  const ctx = toContext(await res.json());
  if (!ctx) {
    logger.warn("Spur Context API returned a malformed body", meta(ip));
    return null;
  }
  logger.info("Spur Context API response", { ...meta(ip), ...summarize(ctx) });
  return ctx;
}

async function lookup(ip: string, apiKey: string): Promise<boolean> {
  let ctx: SpurContext | null;
  try {
    ctx = await fetchContext(ip, apiKey);
  } catch (error) {
    logger.warn("Spur context lookup failed; failing open", {
      ...meta(ip),
      timedOut: error instanceof Error && error.name === "TimeoutError",
      error,
    });
    ctx = null;
  }
  if (ctx) {
    await writeCache(ip, contextKey(ip), JSON.stringify(ctx), CONTEXT_TTL_SEC);
  } else {
    await writeCache(ip, failedKey(ip), "1", FAILED_TTL_SEC);
  }
  return verdict(ip, ctx);
}

async function waitForResult(ip: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(LOCK_POLL_MS, deadline - Date.now()));
    const cached = await readCache(ip);
    if (cached.state === "miss") continue;
    logger.info("Spur lookup coalesced by single-flight", {
      ...meta(ip),
      savedApiCall: true,
    });
    return cachedVerdict(ip, cached);
  }
  logger.info("Spur lookup coalesced by single-flight", {
    ...meta(ip),
    savedApiCall: false,
  });
  return false;
}

export async function isKeylessIpSuspicious(ip: string): Promise<boolean> {
  const apiKey = config.SPUR_API_KEY;
  if (!apiKey || !isIPv4(ip)) return false;

  const cached = await readCache(ip);
  if (cached.state !== "miss") return cachedVerdict(ip, cached);

  const token = randomUUID();
  let locked: boolean;
  try {
    locked =
      (await redisRateLimitClient.set(
        lockKey(ip),
        token,
        "PX",
        LOCK_TTL_MS,
        "NX",
      )) === "OK";
  } catch (error) {
    logger.warn("Spur context lookup failed; failing open", {
      ...meta(ip),
      timedOut: false,
      error,
    });
    return false;
  }
  if (!locked) return waitForResult(ip);

  try {
    const refreshed = await readCache(ip);
    if (refreshed.state !== "miss") return cachedVerdict(ip, refreshed);
    return await lookup(ip, apiKey);
  } finally {
    await releaseLock(ip, token);
  }
}
