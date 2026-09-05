import { ExecutionError, ResourceLockedError } from "redlock";

// Bound variadic commands well below Dragonfly's 65,536 argument limit.
export const REDIS_COMMAND_CHUNK_SIZE = 1000;

export async function isRedlockContention(error: unknown): Promise<boolean> {
  if (!(error instanceof ExecutionError)) return false;
  const failure = error as {
    attempts: ReadonlyArray<
      Promise<{ votesAgainst: ReadonlyMap<unknown, unknown> }>
    >;
  };
  if (failure.attempts.length === 0) return false;
  const attempts = await Promise.all(failure.attempts);
  return attempts.every(
    attempt =>
      attempt.votesAgainst.size > 0 &&
      [...attempt.votesAgainst.values()].every(
        reason => reason instanceof ResourceLockedError,
      ),
  );
}

/** ioredis resolves per-command failures, including runtime MULTI errors. */
export async function checkedRedisExec(
  execution: Promise<[Error | null, unknown][] | null>,
  operation: string,
): Promise<[Error | null, unknown][]> {
  const results = await execution;
  if (results === null) throw new Error(`Redis ${operation}: no results`);
  for (const [error] of results) {
    if (error) throw error;
  }
  return results;
}
