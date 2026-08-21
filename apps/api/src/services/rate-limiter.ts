import { RateLimiterRedis } from "rate-limiter-flexible";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import Redis from "ioredis";

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

// Keyed by RateLimiterMode so a new mode fails to compile until it has a
// fallback here, rather than silently taking the 500 default below.
const fallbackRateLimits: Record<RateLimiterMode, number> = {
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
  developerSearch: 100,
  labs: 1000,
};

/**
 * Per-minute base rate limits, i.e. the ×1 values. The effective limit is
 * `base × multiplier`, where the multiplier is read from Autumn's `rate_limits`
 * feature. Modes absent here are not multiplier-scaled and use the fallback
 * table.
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
  // Research's historical flat limit becomes its x1 base, so free-tier teams
  // (multiplier x1) see no change while paid tiers scale like every other
  // mode. Bounded by MAX_RATE_LIMITS: unlike scrape/crawl, research requests
  // are a direct upstream proxy with no per-team concurrency queue behind
  // them, so this limiter is the only per-team backstop.
  [RateLimiterMode.Research]: 100,
};

/**
 * Optional ceilings on `base x multiplier`, per minute. Only needed for modes
 * that bypass the concurrency queue, where nothing else bounds a team.
 *
 * `getRateLimitMultiplier` fails OPEN at x2500 when Autumn is unreachable
 * (`ERROR_FALLBACK_RATE_MULTIPLIER`). That is safe for queued modes, whose
 * comment notes the concurrency cap still applies, but research has no such
 * cap -- without a ceiling an Autumn outage would lift every team to
 * 250k/min simultaneously on an unmetered endpoint.
 *
 * Provisional value: sized for headroom over the historical flat limit rather
 * than derived from measured upstream capacity. Revisit once research latency
 * and sustainable concurrency are known.
 */
const MAX_RATE_LIMITS: Partial<Record<RateLimiterMode, number>> = {
  [RateLimiterMode.Research]: 10_000,
};

/**
 * Builds the per-minute rate limiter for a mode from the static fallback table.
 * Used for the preview token, which has no Autumn entity; authenticated teams
 * use getAutumnRateLimiter.
 */
export function getRateLimiter(mode: RateLimiterMode): RateLimiterRedis {
  const rateLimit = fallbackRateLimits?.[mode] ?? 500;

  return createRateLimiter(`${mode}`, rateLimit);
}

/**
 * Builds the per-minute rate limiter for an authenticated team from its Autumn
 * rate-limit multiplier: the effective limit is `base × multiplier` for
 * multiplier-scaled modes (default ×1). Modes without a base fall back to the
 * static table.
 */
export function getAutumnRateLimiter(
  mode: RateLimiterMode,
  multiplier: number = 1,
): RateLimiterRedis {
  const base = BASE_RATE_LIMITS[mode];
  let rateLimit: number;
  if (base !== undefined) {
    const safeMultiplier = multiplier > 0 ? multiplier : 1;
    rateLimit = base * safeMultiplier;
    const ceiling = MAX_RATE_LIMITS[mode];
    if (ceiling !== undefined) rateLimit = Math.min(rateLimit, ceiling);
  } else {
    rateLimit = fallbackRateLimits?.[mode] ?? 500;
  }

  return createRateLimiter(`${mode}`, rateLimit);
}

/**
 * Plan-priority tiers keyed by the minimum Autumn rate-limit multiplier that
 * qualifies. Values mirror the tuned production `plan_priority` for each plan.
 * A customer's multiplier selects the highest tier they meet or exceed, so
 * off-tier multipliers round down.
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
