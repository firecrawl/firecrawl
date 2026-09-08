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

/**
 * Text of each `name(...)` call in source, by matching parentheses.
 *
 * A regex cannot do this. The calls hold arrow functions, objects and
 * template strings, so the closing bracket is not the first one.
 */
function callsOf(source: string, name: string): string[] {
  const found: string[] = [];

  for (const match of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    const from = match.index!;
    let i = from + match[0].length - 1;
    let depth = 0;
    let quote: string | undefined;

    for (; i < source.length; i++) {
      const c = source[i];
      if (quote !== undefined) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = undefined;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        quote = c;
        continue;
      }
      if (source.startsWith("//", i)) {
        const line = source.indexOf("\n", i);
        if (line < 0) break;
        i = line;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(from, i + 1));
  }

  return found;
}

/**
 * Body of each test in a suite, including the test.each form.
 *
 * test.each takes the cases first and the test second, so the test body is
 * the group after the cases.
 */
function testBodies(source: string): string[] {
  const found: string[] = [];

  for (const match of source.matchAll(/\btest(\.each)?\s*\(/g)) {
    if (!match[1]) {
      found.push(callsOf(source.slice(match.index!), "test")[0]);
      continue;
    }
    const cases = callsOf(source.slice(match.index!), "test.each")[0];
    const rest = source.slice(match.index! + cases.length);
    const open = rest.indexOf("(");
    // Reuse the matcher by giving it a name to anchor on.
    const group = callsOf(`each${rest.slice(open)}`, "each")[0];
    found.push(group);
  }

  return found;
}

/** Local async helpers in a suite, by name, with the body each one runs. */
function localHelpers(source: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const match of source.matchAll(/\n(\s*)async function (\w+)\(/g)) {
    const start = match.index! + 1;
    const close = source.indexOf(`\n${match[1]}}`, start);
    found.set(match[2], source.slice(start, close < 0 ? undefined : close));
  }

  return found;
}

/**
 * Worst case of one test body, and the wrapped calls it counts.
 *
 * Each waitForJob costs its bound, one poll interval and the retry budget of
 * the status read. Each other wrapped client call costs the retry budget on
 * its own. A local helper runs inside the test, so its calls count too.
 */
function worstCaseMs(
  body: string,
  helpers: Map<string, string>,
): { calls: number; ms: number } {
  let calls = 0;
  let ms = 0;

  const waits = callsOf(body, "waitForJob");
  for (const wait of waits) {
    const timeout = wait.match(/timeout:\s*(\d+)/);
    const poll = wait.match(/pollInterval:\s*(\d+)/);
    const bound = timeout
      ? Number(timeout[1]) * 1000
      : DEFAULT_JOB_TIMEOUT_MS;
    ms +=
      bound +
      Math.max(1000, (poll ? Number(poll[1]) : 2) * 1000) +
      RETRY_BUDGET_MS;
    calls += 1;
  }

  // The status read sits inside waitForJob, so drop those calls before
  // counting the rest. Longest first, so a shorter call is not cut twice.
  let rest = body;
  for (const wait of [...waits].sort((a, b) => b.length - a.length)) {
    rest = rest.split(wait).join("");
  }

  const direct = rest.match(/client\.\w+\s*\(/g) ?? [];
  ms += direct.length * RETRY_BUDGET_MS;
  calls += direct.length;

  for (const [name, helperBody] of helpers) {
    const uses = rest.match(new RegExp(`\\b${name}\\s*\\(`, "g")) ?? [];
    if (uses.length === 0) continue;
    const inner = worstCaseMs(helperBody, new Map());
    ms += uses.length * inner.ms;
    calls += uses.length * inner.calls;
  }

  return { calls, ms };
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

    // The default is a backstop for a caller that forgets a timeout, not a
    // work allowance. A caller that waits for real work passes its own bound.
    // So the default only has to fit the smallest base any suite uses, which
    // is 60_000 ms. The last read can start just inside the bound and then
    // spend the whole retry budget, so count both.
    expect(DEFAULT_JOB_TIMEOUT_MS + 2_000 + RETRY_BUDGET_MS).toBeLessThan(
      testTimeoutMs(60_000),
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

  test("every wrapped call in a test fits its budget", () => {
    // Guard for the whole class of budget faults. A test spends the retry
    // budget once per wrapped call, not once in total, so the budget has to
    // cover the sum. Otherwise jest fires first and hides the specific
    // message this helper exists to surface.
    const dir = path.resolve(process.cwd(), "src/__tests__/e2e/v2");
    const suites = readdirSync(dir).filter(name => name.endsWith(".test.ts"));
    expect(suites.length).toBeGreaterThan(0);

    let checked = 0;
    let widest = 0;

    for (const name of suites) {
      const source = readFileSync(path.join(dir, name), "utf-8");
      const helpers = localHelpers(source);

      // A helper that calls another helper would hide calls from the sum.
      for (const [self, body] of helpers) {
        for (const other of helpers.keys()) {
          if (other === self) continue;
          expect(body).not.toMatch(new RegExp(`\\b${other}\\s*\\(`));
        }
      }

      const bodies = testBodies(source);
      // The scan must see every test, or a budget goes unchecked.
      expect(bodies.length).toBe(
        (source.match(/\btest(?:\.each)?\s*\(/g) ?? []).length,
      );

      for (const body of bodies) {
        const { calls, ms } = worstCaseMs(body, helpers);
        if (calls === 0) continue;

        // A test that calls the wrapped client needs a budget of its own.
        // Without one jest allows 5s, which any single wait outlasts.
        const budgets = body.match(/testTimeoutMs\((\d[\d_]*)\)/g);
        expect(budgets).not.toBeNull();

        const base = Number(budgets![budgets!.length - 1].replace(/\D/g, ""));
        expect(ms).toBeLessThan(testTimeoutMs(base));

        checked += 1;
        widest = Math.max(widest, calls);
      }
    }

    // The scan must see the known tests, or it stopped working.
    expect(checked).toBeGreaterThanOrEqual(45);
    expect(widest).toBeGreaterThanOrEqual(3);
  });

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
