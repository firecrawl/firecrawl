import { eq } from "drizzle-orm";
import { dbRr } from "../db/connection";
import * as schema from "../db/schema";
import { getValue, setValue } from "../services/redis";
import { logger } from "./logger";

// Propagation delay for edits to api_keys.concurrency.
const LIMIT_CACHE_TTL_SECONDS = 60;

const limitCacheKey = (apiKeyId: number) => `api-key-concurrency:${apiKeyId}`;

/**
 * Returns the API-key-scoped concurrency limit (api_keys.concurrency), or
 * null when the key has no limit of its own. Cached for a minute per key.
 *
 * Fails open (null): unlike the IP allowlist this is a throttle, not a
 * security boundary, and a transient DB/cache error must not stall enqueues.
 */
export async function getApiKeyConcurrencyLimit(
  apiKeyId: number,
): Promise<number | null> {
  const cacheKey = limitCacheKey(apiKeyId);

  try {
    const cached = await getValue(cacheKey);
    if (cached !== null) {
      // only the explicit negative-cache sentinel means "no limit"; anything
      // else malformed is a cache miss so a corrupted entry cannot silently
      // disable the key's gate
      if (cached === "none") return null;
      const parsed = Number(cached);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
      logger.warn("Ignoring malformed API key concurrency cache entry", {
        apiKeyId,
      });
    }
  } catch (error) {
    logger.warn("Failed to read API key concurrency cache", {
      apiKeyId,
      error,
    });
  }

  let limit: number | null = null;
  try {
    const [row] = await dbRr
      .select({ concurrency: schema.api_keys.concurrency })
      .from(schema.api_keys)
      .where(eq(schema.api_keys.id, apiKeyId))
      .limit(1);
    limit =
      typeof row?.concurrency === "number" && row.concurrency > 0
        ? row.concurrency
        : null;
  } catch (error) {
    logger.warn("Failed to load API key concurrency limit", {
      apiKeyId,
      error,
    });
    return null;
  }

  try {
    // "none" is a cached negative so unlimited keys skip the DB read too
    await setValue(cacheKey, String(limit ?? "none"), LIMIT_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("Failed to cache API key concurrency limit", {
      apiKeyId,
      error,
    });
  }

  return limit;
}
