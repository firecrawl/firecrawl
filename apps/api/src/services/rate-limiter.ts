import { RateLimiterRedis } from "rate-limiter-flexible";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import type { TeamFlags } from "../controllers/v1/types";
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
  govSearch: 100,
  labs: 1000,
  exchange: 100,
  // Catalogue reads only; no paid tool runs behind them.
  exchangeDiscover: 10000,
};

/**
 * Per-minute base rate limits, i.e. the ×1 values. The effective limit is
 * `base × multiplier`, where the multiplier is read from Autumn's `rate_limits`
 * feature. Modes absent here are not multiplier-scaled and use the fallback
 * table.
 *
 * Endpoint → mode mapping: agent + extract share `Extract`; interact is
 * `Browser`; interactExecute is `BrowserExecute`; agentStatus is
 * `ExtractStatus`. Exchange data routes (discover, retrieve, records/fetch)
 * match Scrape so an Alexandria call costs the same request budget whichever
 * path it takes.
 */
const BASE_RATE_LIMITS: Partial<Record<RateLimiterMode, number>> = {
  [RateLimiterMode.Scrape]: 10,
  [RateLimiterMode.Exchange]: 10,
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
 * Builds the per-minute rate limiter for a mode from the static fallback table.
 * Used for the preview token, which has no Autumn entity; authenticated teams
 * use getAutumnRateLimiter.
 */
export function getRateLimiter(mode: RateLimiterMode): RateLimiterRedis {
  const rateLimit = fallbackRateLimits?.[mode] ?? 500;

  return createRateLimiter(`${mode}`, rateLimit);
}

/**
 * Reads the per-minute override for one mode from the org flags. Returns
 * undefined when there is no usable override.
 *
 * Bad config is skipped, not thrown on: the value is validated on write, but a
 * broken entry must never break authentication. Only a finite integer above
 * zero counts.
 */
export function getRateLimitOverride(
  mode: RateLimiterMode,
  overrides: unknown,
): number | undefined {
  if (typeof overrides !== "object" || overrides === null) return undefined;
  const value = (overrides as Record<string, unknown>)[mode];
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * Builds the per-minute rate limiter for an authenticated team from its Autumn
 * rate-limit multiplier: the effective limit is `base × multiplier` for
 * multiplier-scaled modes (default ×1). Modes without a base fall back to the
 * static table.
 *
 * An org-level override for the mode replaces that whole computation, so the
 * multiplier and the base table are both discarded. Modes without an override
 * keep the normal result.
 */
export function getAutumnRateLimiter(
  mode: RateLimiterMode,
  multiplier: number = 1,
  flags?: TeamFlags,
): RateLimiterRedis {
  const override = getRateLimitOverride(mode, flags?.rateLimitOverrides);
  if (override !== undefined) {
    return createRateLimiter(`${mode}`, override);
  }

  const base = BASE_RATE_LIMITS[mode];
  let rateLimit: number;
  if (base !== undefined) {
    const safeMultiplier = multiplier > 0 ? multiplier : 1;
    rateLimit = base * safeMultiplier;
  } else {
    rateLimit = fallbackRateLimits?.[mode] ?? 500;
  }

  return createRateLimiter(`${mode}`, rateLimit);
}

/**
 * Modes that get the hosted MCP minimum. Agent clients send scrape and search
 * calls in bursts, so the plan limits refused valid agent work on teams that
 * still had credits.
 */
const HOSTED_MCP_MODES: ReadonlySet<RateLimiterMode> = new Set([
  RateLimiterMode.Scrape,
  RateLimiterMode.Search,
]);

/**
 * Per-minute minimums for hosted MCP calls: 600 below the standard multiplier
 * (free and hobby), 1,000 from it, so standard never sits below hobby. Growth
 * and above are already higher, so they keep their plan limits.
 */
const HOSTED_MCP_MIN_RATE_LIMIT = 600;
const HOSTED_MCP_STANDARD_MIN_RATE_LIMIT = 1000;
const STANDARD_RATE_LIMIT_MULTIPLIER = 50;

/**
 * The limiter for a call the hosted MCP made (verified in controllers/auth.ts),
 * or undefined when the team's normal limit (see getAutumnRateLimiter) is
 * already at least its minimum, under an org override for the mode, and for
 * modes outside HOSTED_MCP_MODES.
 *
 * Where the minimum applies, the call counts in its own bucket, so those hosted
 * MCP calls do not use up the team's API budget for the mode and API calls do
 * not use up the hosted MCP one. Where it does not apply, the call uses the
 * team's normal limiter.
 */
export function getHostedMcpRateLimiter(
  mode: RateLimiterMode,
  multiplier: number = 1,
  flags?: TeamFlags,
): RateLimiterRedis | undefined {
  if (!HOSTED_MCP_MODES.has(mode)) return undefined;
  if (getRateLimitOverride(mode, flags?.rateLimitOverrides) !== undefined) {
    return undefined;
  }
  const base = BASE_RATE_LIMITS[mode];
  if (base === undefined) return undefined;
  const safeMultiplier = multiplier > 0 ? multiplier : 1;
  const minimum =
    safeMultiplier >= STANDARD_RATE_LIMIT_MULTIPLIER
      ? HOSTED_MCP_STANDARD_MIN_RATE_LIMIT
      : HOSTED_MCP_MIN_RATE_LIMIT;
  if (base * safeMultiplier >= minimum) return undefined;
  return createRateLimiter(`hostedMcp:${mode}`, minimum);
}

/**
 * Autumn rate-limit multiplier granted to the hobby plan. Trusted agent
 * traffic (a valid `__agentInterop` secret) is floored at this multiplier so a
 * free team's agent runs are limited like hobby rather than at ×1; see
 * buildAuthenticatedRateLimiter in controllers/auth.ts. Paid plans already
 * meet or exceed it, so the floor only ever lifts free. Pairs with
 * HOBBY_CONCURRENCY_LIMIT in lib/concurrency-limit.ts; change both if the
 * hobby plan in firecrawl-web autumn.config.ts changes.
 */
export const HOBBY_RATE_LIMIT_MULTIPLIER = 10;

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
  {
    minMultiplier: HOBBY_RATE_LIMIT_MULTIPLIER,
    bucketLimit: 100,
    planModifier: 0.3,
  }, // hobby
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
