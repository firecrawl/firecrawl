/**
 * Rate-limit retry for the v2 e2e suites.
 *
 * The e2e suites run against a live API. Each suite mints a CI identity through
 * idmux, and that identity gets the base per-minute limits: 2/min for crawl and
 * extract, 10/min for scrape, search and map, 500/min for job status. Several
 * suites send more calls than that in one minute, so the API answers 429 and the
 * suite fails.
 *
 * This helper wraps a client so every call waits for the limit window to reset
 * and then runs again. It is test-only code. The shipped SDK keeps its own retry
 * behaviour.
 */

/** Attempts per call, including the first one. */
const MAX_ATTEMPTS = 3;

/** Wait used when the error carries no reset time. */
const FALLBACK_WAIT_MS = 30_000;

/** Upper bound for one wait. The API window is 60 seconds. */
const MAX_WAIT_MS = 75_000;

/** Added to the reset time so the retry lands after the window, not on it. */
const WAIT_BUFFER_MS = 1_000;

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** True when the API refused the call because the per-minute limit is spent. */
export function isRateLimitError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { status?: unknown; message?: unknown };
  if (candidate.status === 429) return true;
  return (
    typeof candidate.message === "string" &&
    /rate limit exceeded/i.test(candidate.message)
  );
}

/** Milliseconds to wait before the next attempt. */
export function rateLimitWaitMs(err: unknown): number {
  let seconds: number | undefined;

  const details = (err as { details?: Record<string, unknown> })?.details;
  for (const key of ["retryAfter", "retryAfterSeconds"]) {
    const value = details?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      seconds = value;
      break;
    }
  }

  if (seconds === undefined) {
    const message = (err as { message?: unknown })?.message;
    const match =
      typeof message === "string"
        ? message.match(/retry after (\d+)\s*s/i)
        : null;
    if (match) seconds = Number(match[1]);
  }

  const waitMs =
    seconds !== undefined && seconds > 0
      ? seconds * 1000 + WAIT_BUFFER_MS
      : FALLBACK_WAIT_MS;
  return Math.min(waitMs, MAX_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runWithRetry<T>(
  first: Promise<T>,
  again: () => Promise<T>,
  label: string,
): Promise<T> {
  let pending = first;

  for (let attempt = 1; ; attempt++) {
    try {
      return await pending;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRateLimitError(err)) throw err;
      const waitMs = rateLimitWaitMs(err);
      console.warn(
        `[e2e] ${label} hit the API rate limit. Waiting ${Math.round(
          waitMs / 1000,
        )}s, then attempt ${attempt + 1} of ${MAX_ATTEMPTS}.`,
      );
      await sleep(waitMs);
      pending = again();
    }
  }
}

/**
 * Wraps a client so each method call retries after a rate-limit error.
 *
 * The wrapper only covers the calls the test makes. Methods that return a value
 * other than a promise pass through unchanged.
 */
export function withRateLimitRetry<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;

      return (...args: unknown[]) => {
        const call = () =>
          (value as (...a: unknown[]) => unknown).apply(target, args);
        const result = call();
        if (!isPromiseLike(result)) return result;
        return runWithRetry(
          result,
          call as () => Promise<unknown>,
          String(prop),
        );
      };
    },
  });
}
