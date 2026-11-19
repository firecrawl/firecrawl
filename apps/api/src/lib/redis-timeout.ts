// How long a best-effort Redis command is waited for.
export const REDIS_BEST_EFFORT_TIMEOUT_MS = 1000;

/**
 * Stops waiting for a Redis command after `ms` and rejects with the error
 * ioredis uses for its own `commandTimeout`, so callers can treat both alike.
 *
 * For commands whose caller already carries on without the answer: counters,
 * caches, bookkeeping. The command is not cancelled, and it may still run on
 * the server after the wait ends. So do not use this for a command that takes
 * something (LPOP, ZPOPMIN, SET NX, a lock): the caller would lose what the
 * command took.
 */
export function withCommandTimeout<T>(
  command: Promise<T>,
  ms: number = REDIS_BEST_EFFORT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Command timed out")), ms);
    command.then(
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
