import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { logger } from "../../lib/logger";
import { redisRateLimitClient } from "../rate-limiter";
import type { ExchangeResponse } from "./contracts";

// A completed request's response, gzipped, kept for a short while so a repeat of its
// charge id can be answered without running again. It is a cache: an entry that has gone
// only means the repeat is told the response is no longer kept.
const key = (id: string) => `alexandria:response:${id}`;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// How long a completed request's response can be replayed.
const RESPONSE_TTL_SECONDS = 3600;
// A response that is larger than this once gzipped is not kept.
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Whether the response was kept. Never fails the request: a response that could not be
 *  cached is one a repeat cannot get back. */
export async function cacheResponse(
  id: string,
  response: ExchangeResponse,
): Promise<boolean> {
  try {
    const gzipped = await gzipAsync(JSON.stringify(response));
    if (gzipped.length <= MAX_RESPONSE_BYTES) {
      await redisRateLimitClient.set(
        key(id),
        gzipped,
        "EX",
        RESPONSE_TTL_SECONDS,
      );
      return true;
    }
  } catch (error) {
    logger.warn("Alexandria response was not cached for replay", {
      chargeId: id,
      error,
    });
  }
  // Whatever an earlier run of this charge id left must not answer for this one.
  try {
    await redisRateLimitClient.del(key(id));
  } catch (error) {
    logger.warn("Alexandria stale cached response could not be removed", {
      chargeId: id,
      error,
    });
  }
  return false;
}

export async function cachedResponse(
  id: string,
): Promise<ExchangeResponse | null> {
  // A read that fails is not a miss: the entry may well be there. It fails the repeat, which
  // the caller answers with a retry of the same x-request-id, where a miss would tell the
  // client its response is gone and to pay for the request again.
  const raw = await redisRateLimitClient.getBuffer(key(id));
  if (!raw) return null;
  try {
    return JSON.parse((await gunzipAsync(raw)).toString("utf8"));
  } catch (error) {
    // An entry that cannot be read is one the cache does not have.
    logger.warn("Alexandria cached response could not be read", {
      chargeId: id,
      error,
    });
    return null;
  }
}
