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
 * Modes whose concurrency the hosted MCP tier raises. Scrape is the mode that
 * checks the team semaphore at request time (`/v2/scrape` and `/v2/parse`),
 * so the raised scrape rate is not cut back to the plan's concurrency; other
 * modes keep the plan's concurrency.
 */
const HOSTED_MCP_CONCURRENCY_MODES: ReadonlySet<RateLimiterMode> = new Set([
  RateLimiterMode.Scrape,
]);

/** Autumn rate-limit multipliers of the standard and growth plans. */
const STANDARD_RATE_LIMIT_MULTIPLIER = 50;
const GROWTH_RATE_LIMIT_MULTIPLIER = 500;

type HostedMcpTier = { rateMultiplier: number; concurrency: number };

/**
 * Minimums for hosted MCP calls by plan. The rate multiplier applies to every
 * multiplier-scaled mode in BASE_RATE_LIMITS, so each endpoint scales evenly:
 * ×60 is 600/min on scrape and search on free and hobby, and ×200 is 2,000/min
 * on standard. The concurrency minimum keeps the team semaphore from cutting
 * the raised scrape rate back to the plan's concurrency.
 */
const HOSTED_MCP_FREE: HostedMcpTier = { rateMultiplier: 60, concurrency: 25 };
const HOSTED_MCP_HOBBY: HostedMcpTier = { rateMultiplier: 60, concurrency: 50 };
const HOSTED_MCP_STANDARD: HostedMcpTier = {
  rateMultiplier: 200,
  concurrency: 75,
};

/**
 * The hosted MCP tier for a team's Autumn plan multiplier: free below hobby,
 * hobby from hobby, standard from standard, so off-tier variants round down
 * to the tier below them. Undefined from growth up and under an org override
 * for the mode, which keep their own limits.
 */
function hostedMcpTier(
  mode: RateLimiterMode,
  multiplier: number,
  flags?: TeamFlags,
): HostedMcpTier | undefined {
  if (getRateLimitOverride(mode, flags?.rateLimitOverrides) !== undefined) {
    return undefined;
  }
  const safeMultiplier = multiplier > 0 ? multiplier : 1;
  if (safeMultiplier >= GROWTH_RATE_LIMIT_MULTIPLIER) return undefined;
  if (safeMultiplier >= STANDARD_RATE_LIMIT_MULTIPLIER) {
    return HOSTED_MCP_STANDARD;
  }
  if (safeMultiplier >= HOBBY_RATE_LIMIT_MULTIPLIER) return HOSTED_MCP_HOBBY;
  return HOSTED_MCP_FREE;
}

/**
 * The limiter for a call the hosted MCP made (verified in controllers/auth.ts)
 * at `base × tier multiplier` (see hostedMcpTier), or undefined for modes
 * without a base (flat limits), when there is no tier, or when the team's own
 * multiplier is already at least the tier's.
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
  const base = BASE_RATE_LIMITS[mode];
  if (base === undefined) return undefined;
  const tier = hostedMcpTier(mode, multiplier, flags);
  if (!tier) return undefined;
  const safeMultiplier = multiplier > 0 ? multiplier : 1;
  if (safeMultiplier >= tier.rateMultiplier) return undefined;
  return createRateLimiter(`hostedMcp:${mode}`, base * tier.rateMultiplier);
}

/**
 * The concurrency limit for a hosted MCP scrape call at its plan tier (see
 * hostedMcpTier), or undefined for other modes, when there is no tier, or
 * when the team's own limit is already at least the tier's.
 *
 * This raises the ceiling the request checks against the team's shared
 * concurrency pool; it is not a pool of its own, so the team cannot run its
 * plan limit plus the tier's at once.
 */
export function getHostedMcpConcurrencyLimit(
  mode: RateLimiterMode,
  concurrencyLimit: number,
  multiplier: number = 1,
  flags?: TeamFlags,
): number | undefined {
  if (!HOSTED_MCP_CONCURRENCY_MODES.has(mode)) return undefined;
  const tier = hostedMcpTier(mode, multiplier, flags);
  if (!tier || concurrencyLimit >= tier.concurrency) return undefined;
  return tier.concurrency;
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
