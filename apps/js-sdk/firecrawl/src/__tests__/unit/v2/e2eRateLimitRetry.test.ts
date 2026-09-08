import { describe, expect, jest, test } from "@jest/globals";
import {
  isRateLimitError,
  rateLimitWaitMs,
  withRateLimitRetry,
} from "../../e2e/v2/utils/rateLimit";

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

  test("leaves values that are not promises alone", () => {
    const watcher = jest.fn(() => ({ kind: "crawl" }));
    const client = withRateLimitRetry({ watcher, apiUrl: "https://example.com" });

    expect(client.watcher()).toEqual({ kind: "crawl" });
    expect(client.apiUrl).toBe("https://example.com");
  });
});
