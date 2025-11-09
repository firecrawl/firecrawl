import type { Logger } from "winston";
import { cancelScrapeJob } from "../../../services/job-cancellation";

interface BindCancellationOptions {
  abortSignal?: AbortSignal;
  jobId: string;
  teamId: string;
  reason: string;
  logger: Logger;
}

/**
 * Binds job cancellation to an AbortSignal, ensuring we also handle the case where the
 * signal is already aborted (e.g., client disconnects while we await addScrapeJob).
 * Returns a cleanup function that removes the listener once the job is complete.
 */
export function bindScrapeJobCancellation({
  abortSignal,
  jobId,
  teamId,
  reason,
  logger,
}: BindCancellationOptions): () => void {
  if (!abortSignal) {
    return () => {};
  }

  let listener: (() => void) | undefined;
  let cancelled = false;

  const cancelJob = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    cancelScrapeJob({
      jobId,
      teamId,
      reason,
      logger,
    }).catch(error => {
      logger.debug("Failed to cancel scrape job", { error, jobId });
    });
  };

  const cleanup = () => {
    if (listener && !cancelled) {
      abortSignal.removeEventListener("abort", listener);
    }
    listener = undefined;
  };

  const maybeCancelImmediately = () => {
    if (abortSignal.aborted) {
      cleanup();
      cancelJob();
    }
  };

  listener = () => {
    cleanup();
    cancelJob();
  };

  abortSignal.addEventListener("abort", listener, { once: true });
  maybeCancelImmediately();

  return () => {
    cleanup();
  };
}
