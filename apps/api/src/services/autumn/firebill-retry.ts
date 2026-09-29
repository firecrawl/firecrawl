import { logger } from "../../lib/logger";
import { getRedisConnection } from "../queue-service";
import type { TrackParams } from "./types";
import { firebillTrackRetryTotal } from "./metrics";

/**
 * A usage event firebill never confirmed, kept in Redis and retried in the
 * background until firebill takes it.
 *
 * Without this, `firebillTrack` gives up after its two in-request attempts and
 * the usage is gone: on 2026-09-28, 317 events hit both 5s deadlines while a
 * firebill pod was frozen by node memory pressure, and at least 69 of them never
 * reached Autumn. Retrying here costs the caller nothing — it has already been
 * answered — and is safe because every retry carries the event's original
 * idempotency key, so one that did land the first time is deduped by Autumn.
 */
export type PendingTrack = {
  path: string;
  params: TrackParams & { idempotencyKey: string };
  firstFailedAt: number;
  attempts: number;
};

export type AttemptOnce = (
  path: string,
  params: TrackParams,
) => Promise<{ ok: boolean }>;

const DUE_KEY = "firebill:track-retry:due";
const PAYLOAD_KEY = "firebill:track-retry:payload";
const LOCK_KEY = "firebill:track-retry:lock";

// Bounds the in-request cost of the handoff. The shared connection is built
// with `maxRetriesPerRequest: null`, so a Redis outage would otherwise hold
// the caller forever.
const HANDOFF_TIMEOUT_MS = 1000;

const TICK_MS = 5000;
const LOCK_MS = 30000;
const BATCH = 200;
const FIRST_DELAY_MS = 5000;
const MAX_DELAY_MS = 120000;
// Kept well inside the window Autumn remembers an idempotency key for: a retry
// that outlives it could charge twice for an event that did land.
export const MAX_AGE_MS = 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(
    FIRST_DELAY_MS * 2 ** Math.max(attempts - 1, 0),
    MAX_DELAY_MS,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Hand an unconfirmed event to the background retrier. `true` means Redis holds
 * it; `false` means it could not be stored, and the usage is as lost as it was
 * before this existed.
 */
export async function handOffTrack(
  path: string,
  params: TrackParams & { idempotencyKey: string },
  now = Date.now(),
): Promise<boolean> {
  const pending: PendingTrack = {
    path,
    params,
    firstFailedAt: now,
    attempts: 0,
  };
  try {
    const redis = getRedisConnection();
    await withTimeout(
      redis
        .multi()
        // NX on both: a second handoff of the same event must not reset its age.
        .hsetnx(PAYLOAD_KEY, params.idempotencyKey, JSON.stringify(pending))
        .zadd(DUE_KEY, "NX", now + FIRST_DELAY_MS, params.idempotencyKey)
        .exec(),
      HANDOFF_TIMEOUT_MS,
    );
    firebillTrackRetryTotal.labels("queued").inc();
    return true;
  } catch (error) {
    firebillTrackRetryTotal.labels("queue_failed").inc();
    logger.error(
      "could not hand an unconfirmed usage event to the firebill retrier; it will not be billed",
      {
        customerId: params.customerId,
        value: params.value,
        idempotencyKey: params.idempotencyKey,
        path,
        error,
      },
    );
    return false;
  }
}

/**
 * One pass over the events that are due. Exported for tests; production runs it
 * on a timer via {@link startFirebillTrackRetries}.
 *
 * Two processes may occasionally attempt the same event — the lock is a lease,
 * not a guarantee. That is harmless: both carry the same key.
 */
export async function retryDueTracks(
  attempt: AttemptOnce,
  now = Date.now(),
): Promise<void> {
  const redis = getRedisConnection();
  const locked = await redis.set(LOCK_KEY, "1", "PX", LOCK_MS, "NX");
  if (locked !== "OK") return;
  try {
    const keys = await redis.zrangebyscore(
      DUE_KEY,
      "-inf",
      now,
      "LIMIT",
      0,
      BATCH,
    );
    // Stop well inside the lease, so a second process never runs beside this one.
    const deadline = Date.now() + LOCK_MS - 10000;
    for (const key of keys) {
      if (Date.now() > deadline) break;
      const raw = await redis.hget(PAYLOAD_KEY, key);
      if (raw === null) {
        await redis.zrem(DUE_KEY, key);
        continue;
      }
      const pending = JSON.parse(raw) as PendingTrack;
      const age = now - pending.firstFailedAt;

      if (age > MAX_AGE_MS) {
        await redis.multi().zrem(DUE_KEY, key).hdel(PAYLOAD_KEY, key).exec();
        firebillTrackRetryTotal.labels("expired").inc();
        logger.error(
          "gave up retrying a usage event firebill never confirmed; it will not be billed",
          {
            customerId: pending.params.customerId,
            value: pending.params.value,
            idempotencyKey: key,
            path: pending.path,
            attempts: pending.attempts,
            ageMs: age,
          },
        );
        continue;
      }

      const result = await attempt(pending.path, pending.params);
      if (result.ok) {
        await redis.multi().zrem(DUE_KEY, key).hdel(PAYLOAD_KEY, key).exec();
        firebillTrackRetryTotal.labels("recovered").inc();
        logger.info(
          "a usage event firebill had not confirmed is now accepted",
          {
            customerId: pending.params.customerId,
            idempotencyKey: key,
            path: pending.path,
            attempts: pending.attempts + 1,
            ageMs: age,
          },
        );
        continue;
      }

      const next: PendingTrack = { ...pending, attempts: pending.attempts + 1 };
      await redis
        .multi()
        .hset(PAYLOAD_KEY, key, JSON.stringify(next))
        .zadd(DUE_KEY, "XX", now + backoffMs(next.attempts), key)
        .exec();
      firebillTrackRetryTotal.labels("retrying").inc();
    }
  } finally {
    await redis.del(LOCK_KEY);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startFirebillTrackRetries(attempt: AttemptOnce): void {
  if (timer) return;
  timer = setInterval(() => {
    retryDueTracks(attempt).catch(error =>
      logger.warn("firebill retry pass failed; the events stay queued", {
        error,
      }),
    );
  }, TICK_MS);
  timer.unref();
}
