import { config } from "../config";
import { redisEvictConnection } from "../services/redis";
import { logger as _logger } from "./logger";
import type { Logger } from "winston";

// A hostname fails fast only after BLOCK_THRESHOLD DNS failures within the
// TTL window, so a single transient resolver failure never blocks a host.
// Reads never extend the TTL, so a blocked hostname re-probes once per
// window. Reads and writes fail open: skipped while the client is
// disconnected (never queued for later delivery) and bounded by a timeout,
// so the scrape path can neither hang nor backlog on cache trouble.

const KEY_PREFIX = "dnsneg:";
const TTL_MS = config.DNS_NEGATIVE_CACHE_TTL_MS;
const BLOCK_THRESHOLD = 2;
const TIMEOUT_MS = 150;

const useDnsNegativeCache = TTL_MS > 0;

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
  if (!useDnsNegativeCache || redisEvictConnection.status !== "ready") {
    return false;
  }
  try {
    const raw = await withTimeout(redisEvictConnection.get(keyFor(hostname)));
    if (raw === TIMED_OUT) {
      logger.warn("Negative DNS cache read timed out", {
        module: "dns-negative-cache",
        hostname,
      });
      return false;
    }
    return raw !== null && Number(raw) >= BLOCK_THRESHOLD;
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
  if (!useDnsNegativeCache || redisEvictConnection.status !== "ready") {
    return;
  }
  try {
    const result = await withTimeout(
      redisEvictConnection
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
