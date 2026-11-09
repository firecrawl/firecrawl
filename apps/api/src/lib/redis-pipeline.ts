// ioredis pipelines (and MULTI transactions) do not reject on per-command
// failures: exec() resolves with an array of [err, result] tuples and the
// caller must inspect it. These helpers implement the shared handling for
// that, so a failing command inside a pipeline is never silently dropped.
//
// Every detection site logs the same canonical line —
//   "Redis pipeline command failed"
// — so all of these events are filterable by that message across services.

type PipelineResults = [Error | null, unknown][] | null;

// Dragonfly rejects commands with more than 2^16 arguments ("invalid
// multibulk length"), so variadic commands over unbounded collections must
// be chunked well below that limit.
export const REDIS_COMMAND_ARG_CHUNK_SIZE = 16000;

export function firstPipelineError(results: PipelineResults): Error | null {
  const err = (results ?? []).find(([e]) => e)?.[0];
  return err ?? null;
}

// Logs the canonical line when a pipeline result contains a command error,
// and returns that error so the caller can decide whether to throw or
// continue. `context` should identify the site (module, method, and any
// relevant IDs); the error itself is added automatically.
export function reportPipelineError(
  results: PipelineResults,
  logger: { error: (message: string, meta: Record<string, unknown>) => void },
  context: Record<string, unknown>,
): Error | null {
  const error = firstPipelineError(results);
  if (error) {
    logger.error("Redis pipeline command failed", { ...context, error });
  }
  return error;
}
