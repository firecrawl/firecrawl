import { RateLimiterRedis } from "rate-limiter-flexible";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import Redis from "ioredis";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";

export const redisRateLimitClient = new Redis(config.REDIS_RATE_LIMIT_URL!);

const createRateLimiter = (keyPrefix, points) =>
  new RateLimiterRedis({
    storeClient: redisRateLimitClient,
    keyPrefix,
    points,
    duration: 60, // Duration in seconds
  });

const fallbackRateLimits: AuthCreditUsageChunk["rate_limits"] = {
  crawl: 15,
  scrape: 100,
  search: 100,
  map: 100,
  extract: 100,
  preview: 25,
  extractStatus: 25000,
  crawlStatus: 25000,
  extractAgentPreview: 10,
  scrapeAgentPreview: 10,
};

export function getRateLimiter(
  mode: RateLimiterMode,
  rate_limits: AuthCreditUsageChunk["rate_limits"] | null,
): RateLimiterRedis {
  return createRateLimiter(
    `${mode}`,
    rate_limits?.[mode] ?? fallbackRateLimits?.[mode] ?? 500,
  );
}
