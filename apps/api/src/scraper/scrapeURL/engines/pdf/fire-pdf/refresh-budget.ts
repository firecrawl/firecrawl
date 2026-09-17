import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { config } from "../../../../../config";

/**
 * Per-team budget for `parsers: [{ type: "pdf", refresh: true }]`.
 *
 * A refresh skips the content cache and forces a billed parse, so an
 * unbounded stream of them could push every request of a team back onto
 * fire-pdf. The budget is small (FIRE_PDF_CACHE_REFRESH_PER_MINUTE, default
 * 10 a minute) and fails closed: when it is exhausted, or the limiter store
 * is unreachable, the request is served from the cache like any other and
 * the decision is logged. 0 disables the option entirely.
 *
 * The rate-limit Redis client is imported lazily so importing the cache
 * module never opens a connection (tests, tooling).
 */
export type RefreshDecision =
  | "allowed"
  | "limited"
  | "disabled"
  | "unavailable";

let limiter: RateLimiterRedis | null = null;

async function budget(): Promise<RateLimiterRedis> {
  if (limiter) return limiter;
  const { redisRateLimitClient } = await import(
    "../../../../../services/rate-limiter.js"
  );
  limiter = new RateLimiterRedis({
    storeClient: redisRateLimitClient,
    keyPrefix: "fire-pdf-cache-refresh",
    points: Math.max(1, config.FIRE_PDF_CACHE_REFRESH_PER_MINUTE),
    duration: 60,
  });
  return limiter;
}

export async function consumeRefresh(
  teamId: string | undefined,
): Promise<RefreshDecision> {
  if (config.FIRE_PDF_CACHE_REFRESH_PER_MINUTE <= 0) return "disabled";
  try {
    await (await budget()).consume(teamId ?? "anonymous", 1);
    return "allowed";
  } catch (err) {
    return err instanceof RateLimiterRes ? "limited" : "unavailable";
  }
}
