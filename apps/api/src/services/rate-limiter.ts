import { RateLimiterRedis } from "rate-limiter-flexible";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import Redis from "ioredis";
import type { AuthCreditUsageChunk } from "../controllers/v1/types";

export const redisRateLimitClient = new Redis(config.REDIS_RATE_LIMIT_URL!, {
  enableAutoPipelining: true,
});

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
  browser: 20,
  browserExecute: 1000,
};

export function getRateLimiter(
  mode: RateLimiterMode,
  rate_limits: AuthCreditUsageChunk["rate_limits"] | null,
): RateLimiterRedis {
  let rateLimit = rate_limits?.[mode] ?? fallbackRateLimits?.[mode] ?? 500;

  if (mode === RateLimiterMode.Search || mode === RateLimiterMode.Scrape) {
    // TEMP: Mogery
    rateLimit = Math.max(rateLimit, 100);
  }

  return createRateLimiter(`${mode}`, rateLimit);
}
