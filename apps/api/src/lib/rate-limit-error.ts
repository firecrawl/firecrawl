/**
 * Helpers for discriminating rate-limiter rejections.
 *
 * `rateLimiter.consume()` from `rate-limiter-flexible` rejects in two very
 * different situations:
 *
 *   1. A genuine rate-limit hit — the rejection is a `RateLimiterRes` carrying
 *      numeric `msBeforeNext` / `consumedPoints` / `remainingPoints` fields.
 *   2. The backing store (rate-limit Redis) is unreachable — and because no
 *      `insuranceLimiter` is configured, the rejection is a plain `Error`.
 *
 * Treating case (2) as case (1) produces a bogus HTTP 429 with `undefined`
 * fields on every authenticated request while the store is down (see issue
 * #3728). These helpers let callers fail-open on infrastructure errors instead.
 */

interface RateLimiterResLike {
  msBeforeNext: number;
  consumedPoints: number;
  remainingPoints: number;
}

/**
 * Type guard: was this rejection a genuine rate-limit hit (a `RateLimiterRes`),
 * as opposed to a backing-store / infrastructure error (a plain `Error`)?
 *
 * Uses a structural check on `msBeforeNext` rather than `instanceof` so it stays
 * correct across module-interop / dual-package edge cases where the constructor
 * identity may differ.
 */
export function isRateLimiterRes(err: unknown): err is RateLimiterResLike {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { msBeforeNext?: unknown }).msBeforeNext === "number"
  );
}

/**
 * Build the user-facing HTTP 429 "rate limit exceeded" message for a genuine
 * rate-limit hit. Kept here so the catch block in the auth controller only
 * formats this message once it has confirmed the rejection is a real
 * `RateLimiterRes`.
 */
export function buildRateLimitMessage(res: RateLimiterResLike): {
  secs: number;
  message: string;
} {
  const secs = Math.round(res.msBeforeNext / 1000) || 1;
  const retryDate = new Date(Date.now() + res.msBeforeNext);
  return {
    secs,
    message: `Rate limit exceeded. Consumed (req/min): ${res.consumedPoints}, Remaining (req/min): ${res.remainingPoints}. Upgrade your plan at https://firecrawl.dev/pricing for increased rate limits or please retry after ${secs}s, resets at ${retryDate}`,
  };
}
