import { config } from "../config";
import { redisEvictConnection } from "../services/redis";
import { logger as _logger } from "./logger";
import type { Logger } from "winston";

// Markers are never refreshed on read, so a dead hostname re-probes once
// per TTL window.

const KEY_PREFIX = "dnsneg:";
const TTL_MS = config.DNS_NEGATIVE_CACHE_TTL_MS;

const useDnsNegativeCache = TTL_MS > 0;

function keyFor(hostname: string): string {
  return KEY_PREFIX + hostname.toLowerCase();
}

export async function isDnsFailureCached(
  hostname: string,
  logger: Logger = _logger,
): Promise<boolean> {
  if (!useDnsNegativeCache) {
    return false;
  }
  try {
    return (await redisEvictConnection.exists(keyFor(hostname))) === 1;
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
  if (!useDnsNegativeCache) {
    return;
  }
  try {
    await redisEvictConnection.set(keyFor(hostname), "1", "PX", TTL_MS);
  } catch (error) {
    logger.warn("Negative DNS cache write failed", {
      module: "dns-negative-cache",
      error,
      hostname,
    });
  }
}
