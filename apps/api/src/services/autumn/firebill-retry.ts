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

/**
 * BullMQ job id for an event. Deterministic, so the same event is queued at
 * most once; encoded so the id carries no `:`, BullMQ's key separator.
 */
export function retryJobId(idempotencyKey: string): string {
  return encodeURIComponent(idempotencyKey);
}

/**
 * Queue an unconfirmed event for background retry. `true` means Redis holds
 * it. `false` means it was not confirmed stored within the caller's budget:
 * either the add failed (the event will not be billed) or it is still in
 * flight, in which case its late outcome is recorded when it settles.
 */
export async function handOffTrack(
  path: string,
  params: TrackParams & { idempotencyKey: string },
): Promise<boolean> {
  const context = {
    customerId: params.customerId,
    value: params.value,
    idempotencyKey: params.idempotencyKey,
    path,
  };
  const failed = (error: unknown) => {
    firebillTrackRetryTotal.labels("queue_failed").inc();
    logger.error(
      "could not queue an unconfirmed usage event for retry; it will not be billed",
      { ...context, error },
    );
  };

  const add = getFirebillTrackRetryQueue().add(
    "track",
    { path, params } satisfies FirebillTrackRetryJobData,
    // Give a frozen pod a moment before the first retry.
    { jobId: retryJobId(params.idempotencyKey), delay: 5000 },
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), HANDOFF_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([
      add.then(() => "added" as const),
      timedOut,
    ]);
    if (outcome === "added") {
      firebillTrackRetryTotal.labels("queued").inc();
      return true;
    }
  } catch (error) {
    failed(error);
    return false;
  } finally {
    clearTimeout(timer);
  }

  // The caller stops waiting here, but the add is still in flight on a client
  // that never gives up, so it may yet land. Record whichever way it settles.
  firebillTrackRetryTotal.labels("queue_slow").inc();
  logger.warn(
    "queueing an unconfirmed usage event is slow; still trying",
    context,
  );
  add.then(() => firebillTrackRetryTotal.labels("queued").inc(), failed);
  return false;
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
    try {
      await job.moveToCompleted({ success: true }, token, false);
    } catch (error) {
      // The event is accepted; a job left behind only re-sends it under the
      // same key. Never let this escape: workerFun would take index-worker down.
      logger.warn("could not complete a recovered firebill retry job", {
        idempotencyKey: params.idempotencyKey,
        error,
      });
    }
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
  try {
    await job.moveToFailed(
      new Error("firebill did not confirm the event"),
      token,
      false,
    );
  } catch (error) {
    // The stalled check hands the job back for another attempt.
    logger.warn("could not reschedule a firebill retry job", {
      idempotencyKey: params.idempotencyKey,
      error,
    });
    return;
  }
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
