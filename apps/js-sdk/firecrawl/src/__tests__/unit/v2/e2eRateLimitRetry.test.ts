import { describe, expect, jest, test } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import Firecrawl from "../../../index";
import {
  COMPOSITE_METHODS,
  DEFAULT_JOB_TIMEOUT_MS,
  RETRY_BUDGET_MS,
  isRateLimitError,
  rateLimitWaitMs,
  testTimeoutMs,
  waitForJob,
  withRateLimitRetry,
} from "../../e2e/v2/utils/rateLimit";

type AsyncCall = () => Promise<string>;

/** Reproduces the error the API returns when the per-minute limit is spent. */
function rateLimitError(seconds: number): Error & { status: number } {
  const err = new Error(
    `Rate limit exceeded. Consumed (req/min): 3, Remaining (req/min): 0. ` +
      `Upgrade your plan at https://firecrawl.dev/pricing for increased rate ` +
      `limits or please retry after ${seconds}s, resets at Tue Sep 08 2026`,
  ) as Error & { status: number };
  err.status = 429;
  return err;
}

describe("e2e rate-limit retry helper", () => {
  test("recognises the rate-limit error and reads its reset time", () => {
    expect(isRateLimitError(rateLimitError(1))).toBe(true);
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error("Bad request"))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);

    // 1s reset plus the 1s buffer.
    expect(rateLimitWaitMs(rateLimitError(1))).toBe(2000);
    // A reset longer than the window is capped.
    expect(rateLimitWaitMs(rateLimitError(600))).toBe(75_000);
    // No reset time in the error, so the fallback applies.
    expect(rateLimitWaitMs(new Error("Rate limit exceeded."))).toBe(30_000);
    expect(rateLimitWaitMs({ details: { retryAfter: 2 } })).toBe(3000);
  });

  test("runs the call again after a rate-limit error", async () => {
    const scrape = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(rateLimitError(1))
      .mockResolvedValueOnce("ok");
    const client = withRateLimitRetry({ scrape });

    await expect(client.scrape()).resolves.toBe("ok");
    expect(scrape).toHaveBeenCalledTimes(2);
  }, 30_000);

  test("stops after the attempt bound and surfaces the error", async () => {
    const scrape = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(rateLimitError(1));
    const client = withRateLimitRetry({ scrape });

    await expect(client.scrape()).rejects.toThrow(/Rate limit exceeded/);
    expect(scrape).toHaveBeenCalledTimes(3);
  }, 30_000);

  test("passes other errors through without waiting", async () => {
    const scrape = jest
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("invalid url"));
    const client = withRateLimitRetry({ scrape });

    await expect(client.scrape()).rejects.toThrow("invalid url");
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  test("never runs a composite method again after a rate-limit error", async () => {
    for (const name of COMPOSITE_METHODS) {
      const method = jest.fn<AsyncCall>().mockRejectedValue(rateLimitError(1));
      const client = withRateLimitRetry<Record<string, AsyncCall>>({
        [name]: method,
      });

      const startedAt = Date.now();
      await expect(client[name]()).rejects.toThrow(/Rate limit exceeded/);

      // One call only. A second call would start a second job.
      expect(method).toHaveBeenCalledTimes(1);
      // The error surfaces at once, so no wait ran either.
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }
  });

  test("returns the result of a composite method that succeeds", async () => {
    const crawl = jest.fn<AsyncCall>().mockResolvedValue("job");
    const client = withRateLimitRetry({ crawl });

    await expect(client.crawl()).resolves.toBe("job");
    expect(crawl).toHaveBeenCalledTimes(1);
  });

  test("every composite name is a method on the client", () => {
    const client = new Firecrawl({ apiKey: "test-key" }) as unknown as Record<
      string,
      unknown
    >;

    for (const name of COMPOSITE_METHODS) {
      expect(typeof client[name]).toBe("function");
    }
  });

  test("the client has no composite method the list misses", () => {
    // Guard for a new waiter method. A composite starts a job through a
    // *Waiter call, or forwards to another composite on this.
    const source = readFileSync(
      path.resolve(process.cwd(), "src/v2/client.ts"),
      "utf-8",
    );

    const found = new Set<string>();
    let current: string | undefined;
    for (const line of source.split("\n")) {
      const signature = line.match(/^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
      if (signature) current = signature[1];
      if (!current) continue;
      const startsJob =
        /\b\w+Waiter\s*\(/.test(line) ||
        new RegExp(`this\\.(${[...COMPOSITE_METHODS].join("|")})\\s*\\(`).test(
          line,
        );
      if (startsJob) found.add(current);
    }

    // The scan must see the known composites, or it stopped working.
    expect([...found].sort()).toEqual([...COMPOSITE_METHODS].sort());
  });

  test("no e2e suite calls a composite method", () => {
    // A composite call in a suite has no retry, so a rate limit fails the test
    // at once. The suites start the job and poll it instead.
    const dir = path.resolve(process.cwd(), "src/__tests__/e2e/v2");
    const suites = readdirSync(dir).filter(name => name.endsWith(".test.ts"));
    expect(suites.length).toBeGreaterThan(0);

    const calls = new RegExp(
      `client\\.(${[...COMPOSITE_METHODS].join("|")})\\s*\\(`,
    );
    const offenders = suites.filter(name =>
      calls.test(readFileSync(path.join(dir, name), "utf-8")),
    );

    expect(offenders).toEqual([]);
  });

  test("waitForJob polls until the job reaches a terminal state", async () => {
    const getStatus = jest
      .fn<() => Promise<{ status: string }>>()
      .mockResolvedValueOnce({ status: "scraping" })
      .mockResolvedValueOnce({ status: "scraping" })
      .mockResolvedValueOnce({ status: "completed" });

    // pollInterval floors at 1s, so three reads take about two seconds.
    await expect(
      waitForJob(getStatus, { pollInterval: 1, timeout: 30 }),
    ).resolves.toEqual({ status: "completed" });
    expect(getStatus).toHaveBeenCalledTimes(3);
  }, 30_000);

  test("waitForJob gives up when the job outlives its timeout", async () => {
    const getStatus = jest
      .fn<() => Promise<{ status: string }>>()
      .mockResolvedValue({ status: "scraping" });

    await expect(
      waitForJob(getStatus, { pollInterval: 1, timeout: 1 }),
    ).rejects.toThrow(/did not finish in 1s/);
  }, 30_000);

  test("waitForJob bounds a caller that passes no timeout", async () => {
    const getStatus = jest
      .fn<() => Promise<{ status: string }>>()
      .mockResolvedValue({ status: "scraping" });

    // The bound is longer than the longest single rate-limit wait, so one wait
    // between two polls cannot spend it.
    const longestWait = rateLimitWaitMs(rateLimitError(600));
    expect(DEFAULT_JOB_TIMEOUT_MS).toBeGreaterThan(longestWait);

    // The error still surfaces inside the smallest suite budget. The last read
    // can start just inside the bound and then spend the whole retry budget.
    expect(DEFAULT_JOB_TIMEOUT_MS + RETRY_BUDGET_MS).toBeLessThan(
      testTimeoutMs(120_000),
    );

    // Fake timers run the whole bound without waiting for it.
    jest.useFakeTimers();
    try {
      const settled = expect(waitForJob(getStatus)).rejects.toThrow(
        new RegExp(`did not finish in ${DEFAULT_JOB_TIMEOUT_MS / 1000}s`),
      );
      await jest.advanceTimersByTimeAsync(DEFAULT_JOB_TIMEOUT_MS + 5_000);
      await settled;
    } finally {
      jest.useRealTimers();
    }

    expect(getStatus).toHaveBeenCalled();
  }, 30_000);

  test("the test timeout fits the worst-case serial retry", () => {
    // Two waits at the 75s cap follow the first attempt.
    expect(RETRY_BUDGET_MS).toBe(150_000);
    expect(testTimeoutMs(60_000)).toBe(210_000);

    // No pair of waits the helper can ask for exceeds the budget.
    const longestWait = rateLimitWaitMs(rateLimitError(600));
    expect(longestWait * 2).toBeLessThanOrEqual(RETRY_BUDGET_MS);
  });

  test("leaves values that are not promises alone", () => {
    const watcher = jest.fn(() => ({ kind: "crawl" }));
    const client = withRateLimitRetry({ watcher, apiUrl: "https://example.com" });

    expect(client.watcher()).toEqual({ kind: "crawl" });
    expect(client.apiUrl).toBe("https://example.com");
  });
});
