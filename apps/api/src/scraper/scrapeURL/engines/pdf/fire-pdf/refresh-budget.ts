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
 * One decision per request. Engines fall back to one another (fire-pdf,
 * then RunPod MU) and each consults the budget, so the decision is
 * remembered by scrape id: a fallback neither spends a second token nor
 * flips to "serve the cached entry" after the first engine was allowed to
 * bypass it. The write path reads the same decision to know whether it
 * may overwrite existing aliases.
 *
 * The rate-limit Redis client is imported lazily so importing the cache
 * module never opens a connection (tests, tooling).
 */
type RefreshDecision = "allowed" | "limited" | "disabled" | "unavailable";

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

// A request is over within minutes; the map is bounded so a burst of
// requests cannot grow it without limit (insertion order = age order).
const DECISION_TTL_MS = 15 * 60 * 1000;
const DECISION_CAP = 20_000;
const decisions = new Map<string, { decision: RefreshDecision; at: number }>();

function prune(now: number): void {
  for (const [scrapeId, entry] of decisions) {
    if (now - entry.at < DECISION_TTL_MS && decisions.size < DECISION_CAP) {
      break;
    }
    decisions.delete(scrapeId);
  }
}

/** The decision already taken for this request, if any. */
export function refreshDecisionFor(
  scrapeId: string | undefined,
): RefreshDecision | undefined {
  if (!scrapeId) return undefined;
  const entry = decisions.get(scrapeId);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= DECISION_TTL_MS) {
    decisions.delete(scrapeId);
    return undefined;
  }
  return entry.decision;
}

async function decide(teamId: string | undefined): Promise<RefreshDecision> {
  if (config.FIRE_PDF_CACHE_REFRESH_PER_MINUTE <= 0) return "disabled";
  try {
    await (await budget()).consume(teamId ?? "anonymous", 1);
    return "allowed";
  } catch (err) {
    return err instanceof RateLimiterRes ? "limited" : "unavailable";
  }
}

/**
 * Spend one refresh of the team's budget for this request, or return the
 * decision this request already got. Without a scrape id every call is a
 * fresh decision.
 */
export async function consumeRefresh(
  teamId: string | undefined,
  scrapeId?: string,
): Promise<RefreshDecision> {
  const prior = refreshDecisionFor(scrapeId);
  if (prior) return prior;
  const decision = await decide(teamId);
  if (scrapeId) {
    const now = Date.now();
    prune(now);
    decisions.set(scrapeId, { decision, at: now });
  }
  return decision;
}
