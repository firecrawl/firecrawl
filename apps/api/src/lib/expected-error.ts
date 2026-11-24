/*
 * Classifies errors as expected outcomes or defects. Kept apart from the
 * tracer so error classes can be loaded where the tracer is mocked.
 */
import { ZodError } from "zod";

/**
 * Marks an error class whose instances are a normal outcome rather than a
 * defect: user-facing scrape failures, engine-loop control flow, timeouts,
 * cancellations, request validation. Such errors still fail their span and are
 * recorded on it, but with `error.expected = true`, so error dashboards and
 * alerts can leave them out and show the unexpected rest. Declare it as a class
 * field (`[EXPECTED_ERROR] = true`) or set it on an instance with
 * `markExpectedError`.
 */
export const EXPECTED_ERROR: unique symbol = Symbol.for(
  "firecrawl.otel.expected_error",
);

export function markExpectedError<T extends object>(error: T): T {
  Object.defineProperty(error, EXPECTED_ERROR, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

export function isExpectedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ((error as { [EXPECTED_ERROR]?: unknown })[EXPECTED_ERROR] === true) {
    return true;
  }
  // Request validation failures answer 400 and are not ours to fix.
  return error instanceof ZodError;
}
