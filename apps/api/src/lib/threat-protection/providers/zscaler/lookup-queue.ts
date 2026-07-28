import { randomUUID } from "crypto";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { logger as _logger } from "../../../logger";
import { redisRateLimitClient } from "../../../../services/rate-limiter";
import { redlock } from "../../../../services/redlock";
import { getOrgZscalerCredentials } from "../../store";
import {
  ZscalerError,
  zscalerLookupUrls,
  type ZscalerCredentials,
  type ZscalerUrlLookupResult,
} from "./client";

// Inline classification plane for the Zscaler ZIA provider.
//
// POST /urlLookup accepts up to 100 URLs per call, but the tenant budget is
// 1 call/second and 400 calls/hour — and the budget counts CALLS, not URLs.
// With scrape workers running on hundreds of pods, per-pod batching would
// fragment the batches and waste the scarce budget, so lookups are funneled
// through one shared per-org queue in Redis with a single drainer:
//
//   1. A waiting scrape RPUSHes {id, url} onto the org's queue and polls its
//      reply key.
//   2. Whichever process notices work tries to become the org's drainer via
//      a non-blocking distributed lock; losers just keep polling.
//   3. The drainer pops up to 100 entries, spends 1 point of the org's
//      hourly budget and 1 point of the 1/second pacer (both enforced in
//      Redis, so they hold across all pods and drainer failovers), calls
//      urlLookup once, and writes each entry's verdict to its reply key.
//
// Fail-fast beats waiting: when the hourly budget is exhausted or the queue
// is too deep to drain before the lookup timeout, the caller gets an
// immediate error and the org's failurePolicy decides — a scrape must never
// sit in a line it cannot exit. Verdicts live only in the short-TTL reply
// keys consumed moments later; there is no verdict cache (ZDR).
//
// Capacity note: the sustained ceiling is ~11 URLs/second per tenant (400
// calls/hour × 100 URLs). Demand above that resolves through the fail-fast
// paths below (queue depth cap, exhausted hourly budget) into the org's
// failurePolicy — scrape concurrency is deliberately NOT throttled.

const logger = _logger.child({ module: "threat-protection-zscaler-lookup" });

const queueKey = (orgId: string) =>
  `threat-protection:zscaler:lookup-queue:${orgId}`;
const replyKey = (id: string) => `threat-protection:zscaler:lookup-reply:${id}`;
const drainLockKey = (orgId: string) =>
  `threat-protection:zscaler:drain-lock:${orgId}`;

const BATCH_SIZE = 100;
// ZIA's published urlLookup quota is 400 calls/hour per tenant; keep headroom
// for connection tests.
const LOOKUP_HOURLY_BUDGET = 380;
// How long one queued lookup may wait for its batched verdict before the
// org's failurePolicy decides.
export const ZSCALER_LOOKUP_TIMEOUT_MS = 15_000;
// Queued-URL depth per org above which new lookups fail fast into the
// failurePolicy instead of waiting in a line they cannot exit.
const MAX_QUEUE_DEPTH = 500;
const REPLY_TTL_SECONDS = 120;
const REPLY_POLL_INTERVAL_MS = 150;
/** Re-attempt to become the drainer this often while waiting (drainer death recovery). */
const DRAINER_REENSURE_INTERVAL_MS = 2000;
/** One idle re-check before the drainer exits, so a straggler doesn't wait a full re-ensure cycle. */
const DRAIN_IDLE_LINGER_MS = 200;
const LOOKUP_CALL_TIMEOUT_MS = 30_000;
// Must comfortably exceed one full iteration (pacer wait + the lookup call
// timeout), or the lock expires mid-iteration and a second drainer starts
// while the first is still replying.
const DRAIN_LOCK_TTL_MS = LOOKUP_CALL_TIMEOUT_MS + 15_000;

interface QueueEntry {
  id: string;
  url: string;
  /** Enqueue time (epoch ms): the drainer drops entries whose requester has given up. */
  at: number;
}

/**
 * Budget keys are tenant-scoped, not org-scoped: ZIA rate limits apply to the
 * customer's tenant, and several Firecrawl orgs may share one.
 */
export function zscalerBudgetKey(credentials: ZscalerCredentials): string {
  return `${credentials.vanityDomain}:${credentials.cloud ?? "default"}`;
}

type ReplyPayload =
  | {
      status: "ok";
      urlClassifications: string[];
      urlClassificationsWithSecurityAlert: string[];
    }
  | { status: "quota" }
  | { status: "error"; message: string };

let hourlyBudget: RateLimiterRedis | undefined;
function getHourlyBudget(): RateLimiterRedis {
  if (!hourlyBudget) {
    hourlyBudget = new RateLimiterRedis({
      storeClient: redisRateLimitClient,
      keyPrefix: "threat-protection:zscaler:lookup-budget",
      points: LOOKUP_HOURLY_BUDGET,
      duration: 3600,
    });
  }
  return hourlyBudget;
}

let perSecondPacer: RateLimiterRedis | undefined;
function getPerSecondPacer(): RateLimiterRedis {
  if (!perSecondPacer) {
    perSecondPacer = new RateLimiterRedis({
      storeClient: redisRateLimitClient,
      keyPrefix: "threat-protection:zscaler:lookup-pacer",
      points: 1,
      duration: 1,
    });
  }
  return perSecondPacer;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Spend one point of the tenant's urlLookup budget outside the queue (the
 * connection test's lookup probe). Throws a quota ZscalerError when the
 * budget is exhausted, so ad-hoc tests can never starve real scrapes.
 */
export async function consumeZscalerLookupBudget(
  credentials: ZscalerCredentials,
): Promise<void> {
  try {
    await getHourlyBudget().consume(zscalerBudgetKey(credentials), 1);
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) {
      throw new ZscalerError(
        "quota",
        "Zscaler urlLookup hourly budget is exhausted",
        undefined,
        rejection.msBeforeNext,
      );
    }
    throw rejection;
  }
}

// =========================================
// Requester side
// =========================================

/**
 * Queue a URL for batched classification and wait for its verdict. Throws a
 * {@link ZscalerError} on quota exhaustion, queue overflow, wait timeout, or
 * a failed provider call — the caller resolves all of those through the
 * org's failurePolicy.
 */
export async function enqueueZscalerLookup(
  orgId: string,
  lookupUrl: string,
  signal?: AbortSignal,
): Promise<ZscalerUrlLookupResult> {
  // Fail fast on a queue that cannot drain before the wait timeout. The
  // LLEN/RPUSH pair is deliberately non-atomic: this is a fail-fast
  // heuristic, and a brief overshoot from concurrent enqueuers is bounded
  // by their count and harmless.
  const depth = await redisRateLimitClient.llen(queueKey(orgId));
  if (depth >= MAX_QUEUE_DEPTH) {
    throw new ZscalerError(
      "quota",
      `Zscaler lookup queue is over capacity (${depth} URLs waiting)`,
    );
  }

  // Fail fast when the hourly budget is already spent — enqueueing would
  // only park the scrape until the timeout. Budget state is keyed by the
  // ZIA tenant, which needs the org's credentials (60s-cached read).
  const credentials = await getOrgZscalerCredentials(orgId);
  if (credentials) {
    const budgetState = await getHourlyBudget()
      .get(zscalerBudgetKey(credentials))
      .catch(() => null);
    if (budgetState && budgetState.consumedPoints >= LOOKUP_HOURLY_BUDGET) {
      throw new ZscalerError(
        "quota",
        "Zscaler urlLookup hourly budget is exhausted",
        undefined,
        budgetState.msBeforeNext,
      );
    }
  }

  const entry: QueueEntry = {
    id: randomUUID(),
    url: lookupUrl,
    at: Date.now(),
  };
  await redisRateLimitClient.rpush(queueKey(orgId), JSON.stringify(entry));
  ensureQueueDrainer(orgId);

  let lastDrainerCheck = Date.now();
  for (;;) {
    if (signal?.aborted) {
      throw new ZscalerError(
        "api",
        "Timed out waiting for the batched Zscaler verdict",
      );
    }

    const raw = await redisRateLimitClient.get(replyKey(entry.id));
    if (raw !== null) {
      redisRateLimitClient.del(replyKey(entry.id)).catch(() => {});
      let payload: ReplyPayload;
      try {
        payload = JSON.parse(raw) as ReplyPayload;
      } catch {
        throw new ZscalerError("api", "Malformed Zscaler lookup reply");
      }
      if (payload.status === "ok") {
        // A parseable but malformed reply must become a provider failure,
        // not invalid category data inside policy evaluation.
        if (
          !Array.isArray(payload.urlClassifications) ||
          !Array.isArray(payload.urlClassificationsWithSecurityAlert)
        ) {
          throw new ZscalerError("api", "Malformed Zscaler lookup reply");
        }
        return {
          url: lookupUrl,
          urlClassifications: payload.urlClassifications.filter(
            (value): value is string => typeof value === "string",
          ),
          urlClassificationsWithSecurityAlert:
            payload.urlClassificationsWithSecurityAlert.filter(
              (value): value is string => typeof value === "string",
            ),
        };
      }
      if (payload.status === "quota") {
        throw new ZscalerError(
          "quota",
          "Zscaler urlLookup hourly budget is exhausted",
        );
      }
      throw new ZscalerError("api", payload.message);
    }

    // The drainer may have died with our entry unclaimed (its lock expires
    // within DRAIN_LOCK_TTL_MS); periodically try to become / revive it.
    if (Date.now() - lastDrainerCheck >= DRAINER_REENSURE_INTERVAL_MS) {
      lastDrainerCheck = Date.now();
      ensureQueueDrainer(orgId);
    }

    await sleep(REPLY_POLL_INTERVAL_MS);
  }
}

// =========================================
// Drainer side
// =========================================

const drainersInFlight = new Set<string>();

/** Fire-and-forget: try to become the org's queue drainer. */
function ensureQueueDrainer(orgId: string): void {
  if (drainersInFlight.has(orgId)) return;
  drainersInFlight.add(orgId);
  drainQueue(orgId)
    .catch(error => {
      logger.warn("Zscaler lookup queue drainer failed", { error, orgId });
    })
    .finally(() => {
      drainersInFlight.delete(orgId);
    });
}

async function popBatch(orgId: string): Promise<QueueEntry[]> {
  const raw = await redisRateLimitClient.lpop(queueKey(orgId), BATCH_SIZE);
  if (!raw) return [];
  const entries: QueueEntry[] = [];
  for (const item of raw) {
    try {
      const parsed = JSON.parse(item) as QueueEntry;
      if (typeof parsed.id === "string" && typeof parsed.url === "string") {
        entries.push({
          ...parsed,
          // Entries from a pre-`at` process (deploy rollout window) are of
          // unknown age; treat them as fresh so their requesters still get a
          // verdict instead of an immediate expiry error.
          at: typeof parsed.at === "number" ? parsed.at : Date.now(),
        });
      }
    } catch {
      // Skip malformed entries; their requesters time out into failurePolicy.
    }
  }
  return entries;
}

// Entries whose requester has certainly stopped polling (its wait timeout
// plus a grace period has passed). Spending budget on them would classify
// URLs nobody is waiting for.
const ENTRY_EXPIRY_GRACE_MS = 2000;

function isExpired(entry: QueueEntry): boolean {
  return (
    Date.now() - entry.at > ZSCALER_LOOKUP_TIMEOUT_MS + ENTRY_EXPIRY_GRACE_MS
  );
}

async function replyAll(
  entries: QueueEntry[],
  payloadFor: (entry: QueueEntry) => ReplyPayload,
): Promise<void> {
  const pipeline = redisRateLimitClient.pipeline();
  for (const entry of entries) {
    pipeline.set(
      replyKey(entry.id),
      JSON.stringify(payloadFor(entry)),
      "EX",
      REPLY_TTL_SECONDS,
    );
  }
  await pipeline.exec();
}

async function drainQueue(orgId: string): Promise<void> {
  let lock;
  try {
    lock = await redlock.acquire([drainLockKey(orgId)], DRAIN_LOCK_TTL_MS, {
      retryCount: 0,
    });
  } catch {
    // Another process is draining this org.
    return;
  }

  try {
    const credentials = await getOrgZscalerCredentials(orgId);

    for (;;) {
      let entries = await popBatch(orgId);
      if (entries.length === 0) {
        // A URL enqueued a moment after our pop should not wait for the next
        // re-ensure cycle; check once more before exiting.
        await sleep(DRAIN_IDLE_LINGER_MS);
        entries = await popBatch(orgId);
        if (entries.length === 0) return;
      }

      // Abandoned entries (requester timed out) get a free error reply
      // instead of a budgeted classification.
      const expired = entries.filter(isExpired);
      if (expired.length > 0) {
        await replyAll(expired, () => ({
          status: "error",
          message: "The lookup request expired before the batch was sent",
        })).catch(() => {});
        entries = entries.filter(entry => !isExpired(entry));
        if (entries.length === 0) continue;
      }

      // From here on the popped entries are this drainer's responsibility:
      // an unexpected throw (Redis blip, expired lock) must not orphan them
      // into their full wait timeout — reply an error first, then unwind.
      try {
        lock = await lock.extend(DRAIN_LOCK_TTL_MS);

        if (!credentials) {
          await replyAll(entries, () => ({
            status: "error",
            message: "No Zscaler credentials are configured for this org",
          }));
          continue;
        }

        // Hourly budget: one point per urlLookup CALL, keyed by the ZIA
        // tenant. When it is gone, this loop keeps popping and answers
        // everything "quota" without touching the tenant, so waiting scrapes
        // resolve immediately via failurePolicy.
        const budgetKey = zscalerBudgetKey(credentials);
        try {
          await getHourlyBudget().consume(budgetKey, 1);
        } catch (rejection) {
          if (rejection instanceof RateLimiterRes) {
            await replyAll(entries, () => ({ status: "quota" }));
            continue;
          }
          throw rejection;
        }

        // 1 call/second pacer.
        for (;;) {
          try {
            await getPerSecondPacer().consume(budgetKey, 1);
            break;
          } catch (rejection) {
            if (rejection instanceof RateLimiterRes) {
              await sleep(Math.max(rejection.msBeforeNext, 50));
              continue;
            }
            throw rejection;
          }
        }
      } catch (error) {
        await replyAll(entries, () => ({
          status: "error",
          message: "Zscaler lookup drainer failed before the batch was sent",
        })).catch(() => {});
        throw error;
      }

      const uniqueUrls = [...new Set(entries.map(entry => entry.url))];
      try {
        const results = await zscalerLookupUrls(credentials, uniqueUrls, {
          signal: AbortSignal.timeout(LOOKUP_CALL_TIMEOUT_MS),
        });
        const byUrl = new Map(results.map(result => [result.url, result]));
        await replyAll(entries, entry => {
          const result = byUrl.get(entry.url);
          if (!result) {
            return {
              status: "error",
              message: "Zscaler returned no verdict for this URL",
            };
          }
          return {
            status: "ok",
            urlClassifications: result.urlClassifications,
            urlClassificationsWithSecurityAlert:
              result.urlClassificationsWithSecurityAlert,
          };
        });
      } catch (error) {
        const zscalerError =
          error instanceof ZscalerError
            ? error
            : new ZscalerError(
                "api",
                error instanceof Error ? error.message : String(error),
              );
        logger.warn("Batched Zscaler urlLookup call failed", {
          error,
          orgId,
          kind: zscalerError.kind,
          urls: uniqueUrls.length,
        });
        if (
          zscalerError.kind === "rate-limit" &&
          zscalerError.retryAfterMs !== undefined
        ) {
          // Tenant-side 429 (something else shares the tenant's budget):
          // pause the drainer so we do not compound it. The current batch
          // still fails into failurePolicy — no retries that could stall
          // every waiting scrape behind one bad call.
          await sleep(Math.min(zscalerError.retryAfterMs, 10_000));
        }
        await replyAll(entries, () => ({
          status: "error",
          message: zscalerError.message,
        }));
      }
    }
  } finally {
    await lock.release().catch(() => {});
  }
}
