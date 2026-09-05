import { ExecutionError, ResourceLockedError } from "redlock";

// Bound variadic commands well below Dragonfly's 65,536 argument limit.
export const REDIS_COMMAND_CHUNK_SIZE = 1000;

// Redis errors can carry command arguments. Never attach the raw error to logs.
export function redisErrorDetails(error: unknown): { redisError: string } {
  const codes =
    /^(WRONGTYPE|OOM|READONLY|NOAUTH|NOPERM|LOADING|BUSY|NOSCRIPT|EXECABORT|ERR|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  const message = error instanceof Error ? error.message : "";
  return {
    redisError:
      code.match(codes)?.[1] ?? message.match(codes)?.[1] ?? "unknown",
  };
}

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
  let results: [Error | null, unknown][] | null;
  try {
    results = await execution;
  } catch (error) {
    throw new Error(
      `Redis ${operation}: execution failed (${redisErrorDetails(error).redisError})`,
    );
  }
  if (results === null) throw new Error(`Redis ${operation}: no results`);
  const index = results.findIndex(([error]) => error !== null);
  if (index !== -1) {
    throw new Error(
      `Redis ${operation}: command ${index} failed (${redisErrorDetails(results[index][0]).redisError})`,
    );
  }
  return results;
}
