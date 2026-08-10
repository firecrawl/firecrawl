import IORedis from "ioredis";
import { config } from "../config";
import { logger as _logger } from "./logger";
import type { Logger } from "winston";

// A hostname fails fast only after BLOCK_THRESHOLD DNS failures within the
// TTL window, so a single transient resolver failure never blocks a host.
// Reads never extend the TTL, so a blocked hostname re-probes once per
// window. Everything fails open: the dedicated client rejects commands
// immediately while disconnected (never queues or retries them), and calls
// are bounded by a timeout so the scrape path can never hang on the cache.

const KEY_PREFIX = "dnsneg:";
const TTL_MS = Math.floor(config.DNS_NEGATIVE_CACHE_TTL_MS);
const BLOCK_THRESHOLD = 2;
const TIMEOUT_MS = 150;

const useDnsNegativeCache = TTL_MS > 0;

export const dnsNegativeCacheRedis: IORedis | null = useDnsNegativeCache
  ? new IORedis((config.REDIS_EVICT_URL ?? config.REDIS_RATE_LIMIT_URL)!, {
      enableAutoPipelining: true,
      enableOfflineQueue: false,
      // Callers time out in 150ms, so a retried or resent command can only
      // ever deliver a stale write after the scrape has moved on.
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
    })
  : null;

dnsNegativeCacheRedis?.on("error", error => {
  _logger.warn("Negative DNS cache Redis connection error", {
    module: "dns-negative-cache",
    error,
  });
});

const TIMED_OUT = Symbol("dns-negative-cache-timeout");

function withTimeout<T>(promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>(resolve =>
      setTimeout(() => resolve(TIMED_OUT), TIMEOUT_MS).unref?.(),
    ),
  ]);
}

function keyFor(hostname: string): string {
  return KEY_PREFIX + hostname.toLowerCase();
}

export async function isDnsFailureCached(
  hostname: string,
  logger: Logger = _logger,
): Promise<boolean> {
  if (
    dnsNegativeCacheRedis === null ||
    dnsNegativeCacheRedis.status !== "ready"
  ) {
    return false;
  }
  try {
    const raw = await withTimeout(dnsNegativeCacheRedis.get(keyFor(hostname)));
    if (raw === TIMED_OUT) {
      logger.warn("Negative DNS cache read timed out", {
        module: "dns-negative-cache",
        hostname,
      });
      return false;
    }
    if (raw === null) {
      return false;
    }
    const count = Number(raw);
    return Number.isSafeInteger(count) && count >= BLOCK_THRESHOLD;
  } catch (error) {
    logger.warn("Negative DNS cache read failed", {
      module: "dns-negative-cache",
      error,
      hostname,
    });
    return false;
  }
}

export async function cacheDnsFailure(
  hostname: string,
  logger: Logger = _logger,
): Promise<void> {
  if (
    dnsNegativeCacheRedis === null ||
    dnsNegativeCacheRedis.status !== "ready"
  ) {
    return;
  }
  try {
    const result = await withTimeout(
      dnsNegativeCacheRedis
        .pipeline()
        .incr(keyFor(hostname))
        .pexpire(keyFor(hostname), TTL_MS)
        .exec(),
    );
    if (result === TIMED_OUT) {
      logger.warn("Negative DNS cache write timed out", {
        module: "dns-negative-cache",
        hostname,
      });
    }
  } catch (error) {
    logger.warn("Negative DNS cache write failed", {
      module: "dns-negative-cache",
      error,
      hostname,
    });
  }
}
