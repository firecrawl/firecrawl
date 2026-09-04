import Redis from "ioredis";
import { config } from "../config";
import { logger } from "../lib/logger";
import { redisRateLimitClient } from "./rate-limiter";

// Keep existing self-hosted configurations working without another datastore.
// Once configured, outages must fail open in Spur, not fall back to an old cache.
export const redisSpurClient = config.SPUR_REDIS_URL
  ? new Redis(config.SPUR_REDIS_URL, {
      enableAutoPipelining: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
    })
  : redisRateLimitClient;

if (config.SPUR_REDIS_URL) {
  redisSpurClient.on("error", () => {
    logger.warn("Spur Redis connection error", { module: "spur-redis" });
  });
}
