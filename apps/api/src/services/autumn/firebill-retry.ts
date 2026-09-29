import type { Job } from "bullmq";
import { logger } from "../../lib/logger";
import { getFirebillTrackRetryQueue } from "../queue-service";
import type { TrackParams } from "./types";
import { firebillTrackRetryTotal } from "./metrics";

/**
 * A usage event firebill never confirmed, retried in the background until
 * firebill takes it. Without this, `firebillTrack` gives up after its two
 * in-request attempts and the usage is never billed.
 *
 * Safe to retry because every attempt carries the event's original
 * idempotency key: one that did land the first time is deduped by Autumn.
 */
export type FirebillTrackRetryJobData = {
  path: string;
  params: TrackParams & { idempotencyKey: string };
};

export type AttemptOnce = (
  path: string,
  params: TrackParams,
) => Promise<{ ok: boolean }>;

// The shared Redis client never times out on its own
// (`maxRetriesPerRequest: null`), so this bounds what the caller can wait.
const HANDOFF_TIMEOUT_MS = 1000;

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
 * Queue an unconfirmed event for background retry. `true` means Redis holds
 * it; `false` means it could not be stored and will not be billed.
 *
 * The job id is the idempotency key, so handing off the same event twice
 * queues it once.
 */
export async function handOffTrack(
  path: string,
  params: TrackParams & { idempotencyKey: string },
): Promise<boolean> {
  try {
    await withTimeout(
      getFirebillTrackRetryQueue().add(
        "track",
        { path, params } satisfies FirebillTrackRetryJobData,
        // Give a frozen pod a moment before the first retry.
        { jobId: params.idempotencyKey, delay: 5000 },
      ),
      HANDOFF_TIMEOUT_MS,
    );
    firebillTrackRetryTotal.labels("queued").inc();
    return true;
  } catch (error) {
    firebillTrackRetryTotal.labels("queue_failed").inc();
    logger.error(
      "could not queue an unconfirmed usage event for retry; it will not be billed",
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
 * One attempt at a queued event, for the index-worker's manual job loop. A
 * failed attempt is handed back to BullMQ, which reschedules it with the
 * queue's backoff until its attempts run out.
 */
export async function processFirebillTrackRetryJob(
  token: string,
  job: Job<FirebillTrackRetryJobData>,
  attempt: AttemptOnce,
): Promise<void> {
  const { path, params } = job.data;
  const result = await attempt(path, params).catch(() => ({ ok: false }));

  if (result.ok) {
    await job.moveToCompleted({ success: true }, token, false);
    firebillTrackRetryTotal.labels("recovered").inc();
    logger.info("a usage event firebill had not confirmed is now accepted", {
      customerId: params.customerId,
      idempotencyKey: params.idempotencyKey,
      path,
      attempts: job.attemptsMade + 1,
    });
    return;
  }

  const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  await job.moveToFailed(
    new Error("firebill did not confirm the event"),
    token,
    false,
  );
  if (!last) {
    firebillTrackRetryTotal.labels("retrying").inc();
    return;
  }
  firebillTrackRetryTotal.labels("expired").inc();
  logger.error(
    "gave up retrying a usage event firebill never confirmed; it will not be billed",
    {
      customerId: params.customerId,
      value: params.value,
      idempotencyKey: params.idempotencyKey,
      path,
      attempts: job.attemptsMade + 1,
      ageMs: Date.now() - job.timestamp,
    },
  );
}
