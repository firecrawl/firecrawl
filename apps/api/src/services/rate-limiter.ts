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
  browser: 2,
  browserExecute: 1000,
  browserReplay: 500,
  account: 1000,
  supportAsk: 3,
  supportDocsSearch: 3,
  research: 100,
};

/**
 * Per-minute base rate limits, i.e. the ×1 (Free tier) values. The effective
 * limit is `base × multiplier`, where the multiplier is read from Autumn's
 * `rate_limits` feature (Free ×1, Hobby ×10, Standard ×50, …). Modes absent
 * here are not multiplier-scaled and keep their ACUC / fallback value.
 *
 * Endpoint → mode mapping: agent + extract share `Extract`; interact is
 * `Browser`; interactExecute is `BrowserExecute`; agentStatus is
 * `ExtractStatus`.
 */
const BASE_RATE_LIMITS: Partial<Record<RateLimiterMode, number>> = {
  [RateLimiterMode.Scrape]: 10,
  [RateLimiterMode.Map]: 10,
  [RateLimiterMode.Crawl]: 2,
  [RateLimiterMode.Search]: 10,
  [RateLimiterMode.Extract]: 2,
  [RateLimiterMode.Browser]: 2,
  [RateLimiterMode.BrowserExecute]: 10,
  [RateLimiterMode.CrawlStatus]: 500,
  [RateLimiterMode.ExtractStatus]: 500,
};

/**
 * Builds the per-minute rate limiter for a mode. Autumn is authoritative: the
 * effective limit is `base × multiplier` for multiplier-scaled modes, where the
 * multiplier comes from Autumn's `rate_limits` feature (default ×1 when Autumn
 * can't tell us). ACUC rate limits are no longer consulted. Modes without a
 * base fall back to the static fallback table.
 */
export function getRateLimiter(
  mode: RateLimiterMode,
  multiplier: number = 1,
): RateLimiterRedis {
  const base = BASE_RATE_LIMITS[mode];
  let rateLimit: number;
  if (base !== undefined) {
    const safeMultiplier = multiplier > 0 ? multiplier : 1;
    rateLimit = base * safeMultiplier;
  } else {
    rateLimit = fallbackRateLimits?.[mode] ?? 500;
  }

  if (mode === RateLimiterMode.Search || mode === RateLimiterMode.Scrape) {
    // TEMP: Mogery
    rateLimit = Math.max(rateLimit, 100);
  }

  return createRateLimiter(`${mode}`, rateLimit);
}

/**
 * Plan-priority tiers keyed by the minimum Autumn rate-limit multiplier that
 * qualifies. Values mirror the tuned production `plan_priority` for each plan
 * (free ×1 … enterprise ×2500). A customer's multiplier selects the highest
 * tier they meet or exceed, so off-tier multipliers round down (an unusual
 * ×200 customer gets Standard's priority, not Growth's).
 *
 * `bucketLimit` / `planModifier` only affect internal job-scheduling priority
 * (see getJobPriority) — never request success — so inferring them from the
 * multiplier is safe: a wrong guess shifts queue ordering, not correctness.
 */
const PLAN_PRIORITY_TIERS: {
  minMultiplier: number;
  bucketLimit: number;
  planModifier: number;
}[] = [
  { minMultiplier: 1, bucketLimit: 25, planModifier: 0.5 }, // free
  { minMultiplier: 10, bucketLimit: 100, planModifier: 0.3 }, // hobby
  { minMultiplier: 50, bucketLimit: 200, planModifier: 0.2 }, // standard
  { minMultiplier: 500, bucketLimit: 400, planModifier: 0.1 }, // growth
  { minMultiplier: 1000, bucketLimit: 400, planModifier: 0.1 }, // scale
  { minMultiplier: 2500, bucketLimit: 1000, planModifier: 0.05 }, // enterprise
];

/**
 * Infers safe `bucketLimit` / `planModifier` values from a rate-limit
 * multiplier. Monotonic: bucketLimit never decreases and planModifier never
 * increases as the multiplier grows.
 */
export function inferPlanPriorityFromMultiplier(multiplier: number): {
  bucketLimit: number;
  planModifier: number;
} {
  let chosen = PLAN_PRIORITY_TIERS[0];
  for (const tier of PLAN_PRIORITY_TIERS) {
    if (multiplier >= tier.minMultiplier) chosen = tier;
  }
  return { bucketLimit: chosen.bucketLimit, planModifier: chosen.planModifier };
}
