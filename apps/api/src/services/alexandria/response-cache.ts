import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { logger } from "../../lib/logger";
import { redisRateLimitClient } from "../rate-limiter";
import type { ExchangeResponse } from "./contracts";

// A completed request's response, gzipped, kept for a short while so a repeat of its
// charge id can be answered without running again. It is a cache: an entry that has gone
// only means the repeat is told the response is no longer kept.
const key = (id: string) => `alexandria:response:${id}`;
const gunzipAsync = promisify(gunzip);

export async function cachedResponse(
  id: string,
): Promise<ExchangeResponse | null> {
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
