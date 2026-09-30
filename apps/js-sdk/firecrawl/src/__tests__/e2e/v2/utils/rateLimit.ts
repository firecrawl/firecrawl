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
 *
 * Batch scrape creation counts against the scrape limit, not a limit of its
 * own. Job status reads use the 500/min limit, so they almost never wait.
 *
 * The wrapper only runs a call again when the refused request created nothing.
 * A single request is safe: the API rejected it, so no job exists. A composite
 * method is not safe. It starts a job, then polls that job. The poll can hit
 * the limit after the job exists, and a second run of the method would start a
 * second job. The wrapper passes these methods straight through, so they get no
 * retry. See COMPOSITE_METHODS.
 *
 * A suite that needs a job therefore does the two steps itself: it calls the
 * start method, then waitForJob. Both calls go through the wrapper, so both
 * retry, and the job starts once.
 */

/** Attempts per call, including the first one. */
const MAX_ATTEMPTS = 3;

/** Wait used when the error carries no reset time. */
const FALLBACK_WAIT_MS = 30_000;

/** Upper bound for one wait. The API window is 60 seconds. */
const MAX_WAIT_MS = 75_000;

/** Added to the reset time so the retry lands after the window, not on it. */
const WAIT_BUFFER_MS = 1_000;

/**
 * Worst-case time the retry adds to one call.
 *
 * The first attempt does not wait. Every later attempt waits first, and one
 * wait is never longer than MAX_WAIT_MS. The value comes from the two bounds
 * above, so it cannot drift from them.
 */
export const RETRY_BUDGET_MS = (MAX_ATTEMPTS - 1) * MAX_WAIT_MS;

/**
 * Time waitForJob allows when the caller passes no timeout.
 *
 * Every caller now passes its own timeout, sized to the work it waits for.
 * This value is only a backstop for a new caller that forgets one. Without a
 * bound the poll loop runs until the jest timeout, which hides the reason.
 *
 * The value stays short because it cannot know the work. It fits the smallest
 * base any suite passes to testTimeoutMs, which is 60_000 ms:
 * 45_000 + 2_000 + RETRY_BUDGET_MS = 197_000 ms, inside the 210_000 ms of
 * testTimeoutMs(60_000). So a forgotten timeout still reports "job did not
 * finish" in every test the suites have today.
 *
 * A caller that waits for real work must pass a timeout. Size it to the work,
 * not to the budget, then set the budget from the sum of the calls the test
 * makes. The unit test "every wrapped call in a test fits its budget" holds
 * that rule: it counts this bound, one poll interval, and the retry budget of
 * every wrapped call in the test, and requires the sum to fit.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 45_000;

/**
 * Jest timeout for a test that calls a wrapped client.
 *
 * Pass the base: the time the test needs when the API answers at once. The
 * result adds one retry budget on top, so a test whose single call hits the
 * limit still finishes inside its own timeout instead of failing on it.
 *
 * One retry budget covers one call. A test that makes several wrapped calls
 * can spend the budget once per call, so the base must carry the rest. Do not
 * pick the base by hand: take the number the unit test "every wrapped call in
 * a test fits its budget" computes, which sums every call in the test.
 */
export function testTimeoutMs(baseMs: number): number {
  return baseMs + RETRY_BUDGET_MS;
}

/**
 * Client methods that start a job and then poll it.
 *
 * These never run again after a rate-limit error. A retry would call the whole
 * method, which starts a second job. The single-request methods that the job
 * waiters use inside, such as startCrawl and getCrawlStatus, keep their retry
 * when a test calls them directly.
 */
export const COMPOSITE_METHODS: ReadonlySet<string> = new Set([
  "crawl",
  "crawlUrl",
  "batchScrape",
  "batchScrapeUrls",
  "extract",
  "agent",
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** States a job stops in. Matches the waiters in src/v2/methods. */
const TERMINAL_STATES = ["completed", "failed", "cancelled"];

/** The part of a job snapshot this module reads. */
interface JobSnapshot {
  status?: string;
}

/**
 * Polls a job that a test already started.
 *
 * The composite client methods, such as crawl, start a job and then poll it in
 * one call, so the wrapper cannot run them again. A test uses this instead: it
 * starts the job with the start method, then polls with the status method. Both
 * calls go through the wrapper, so both keep their retry, and the job starts
 * once. Compare waitForCrawlCompletion in src/v2/methods/crawl.ts, which this
 * mirrors.
 *
 * @param getStatus Reads the job state. Call the wrapped client here.
 * @param opts.pollInterval Seconds between reads. Least value is 1.
 * @param opts.timeout Seconds to allow. Throws when the job runs longer.
 *   Defaults to DEFAULT_JOB_TIMEOUT_MS, so the loop always has a bound.
 */
export async function waitForJob<T extends JobSnapshot>(
  getStatus: () => Promise<T>,
  opts: { pollInterval?: number; timeout?: number } = {},
): Promise<T> {
  const pollIntervalMs = Math.max(1000, (opts.pollInterval ?? 2) * 1000);
  const timeoutMs =
    opts.timeout != null ? opts.timeout * 1000 : DEFAULT_JOB_TIMEOUT_MS;
  const startedAt = Date.now();

  let snapshot = await getStatus();
  while (!TERMINAL_STATES.includes(snapshot.status ?? "")) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `job did not finish in ${timeoutMs / 1000}s. Last status: ${
          snapshot.status
        }`,
      );
    }
    await sleep(pollIntervalMs);
    snapshot = await getStatus();
  }
  return snapshot;
}

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
 * other than a promise pass through unchanged, and so do the composite methods
 * listed in COMPOSITE_METHODS.
 */
export function withRateLimitRetry<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;

      const name = String(prop);

      return (...args: unknown[]) => {
        const call = () =>
          (value as (...a: unknown[]) => unknown).apply(target, args);
        const result = call();
        // A composite method already created a job, so never run it again.
        if (COMPOSITE_METHODS.has(name)) return result;
        if (!isPromiseLike(result)) return result;
        return runWithRetry(
          result,
          call as () => Promise<unknown>,
          name,
        );
      };
    },
  });
}
