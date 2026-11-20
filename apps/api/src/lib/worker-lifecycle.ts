import { logger } from "./logger";
import { executeWithRetry } from "./retry-utils";

/**
 * Delays a worker waits out when a dependency (Postgres, RabbitMQ, Valkey) is
 * unreachable. A primary failover or a broker restart lasts minutes, not
 * seconds, so the tail is one minute per attempt: a single outage costs the
 * worker roughly six minutes of retries before its loop starts over.
 */
export const DEPENDENCY_BACKOFF_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
  60_000,
] as const;

/**
 * Runs a dependency call, retrying transient failures with the backoff above.
 *
 * Returns `{ value }` with whatever the operation resolved to — `null` and
 * `undefined` are legitimate results and are not retried — or `null` once the
 * backoff budget is spent. Retrying never throws: a failure that outlasts the
 * budget is the caller's cue to wait and try again rather than exit.
 */
export async function retryDependency<T>(
  operation: () => Promise<T>,
  backoffMs: readonly number[] = DEPENDENCY_BACKOFF_MS,
  signal?: AbortSignal,
): Promise<{ value: T } | null> {
  return executeWithRetry(
    () => operation().then(value => ({ value })),
    (result): result is { value: T } => result !== null,
    // A shutdown has to cut the backoff short: a six-minute wait that ignores
    // SIGTERM turns every rollout into a SIGKILL.
    signal,
    backoffMs.length + 1,
    backoffMs,
  );
}

/**
 * Runs a dependency call whose failure is recoverable — recording a job's
 * outcome, for instance — and logs instead of throwing when it fails. Returns
 * whether the call succeeded.
 */
export async function guardDependencyCall(
  operation: () => Promise<unknown>,
  log: { error: (message: string, meta?: unknown) => void },
  message: string,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    log.error(message, { error });
    return false;
  }
}

/**
 * Keeps a worker process alive when a promise rejects outside the call sites
 * that handle their own failures. Install it once the worker has finished
 * starting, so a failure to start still takes the process down and the
 * supervisor restarts it.
 *
 * Only `unhandledRejection` is handled. A synchronous `uncaughtException` is
 * a bug in this code rather than a dependency blip, and a worker that keeps
 * consuming jobs in that state is worse than one that restarts.
 */
export function installWorkerLifecycle(serviceName: string): void {
  process.on("unhandledRejection", reason => {
    logger.error("Unhandled rejection in worker; keeping the process alive", {
      module: serviceName,
      error: reason,
    });
  });
}
