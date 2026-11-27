import { createLogger } from "winston";
import { vi } from "vitest";

const { scard, exec, srem, pipeline, withSpan } = vi.hoisted(() => {
  const exec = vi.fn();
  const srem = vi.fn();
  const chain = {
    sadd: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    srem: (...args: Array<unknown>) => {
      srem(...args);
      return chain;
    },
    exec,
  };
  return {
    scard: vi.fn(),
    exec,
    srem,
    pipeline: vi.fn(() => chain),
    withSpan: vi.fn(),
  };
});

vi.mock("../services/redis", () => ({
  redisEvictConnection: {},
  redisCrawlStateConnection: { scard, pipeline },
  redisCrawlStateFallbackConnection: undefined,
}));
vi.mock("../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
  withZeroDataRetention: <T>(_zdr: unknown, fn: () => T): T => fn(),
}));

import { baseScrapeOptions } from "../controllers/v2/types";
import type { StoredCrawl } from "./crawl-redis";
import { lockURL, tryLockURL } from "./crawl-redis";

const crawl = (limit?: number): StoredCrawl => ({
  team_id: "team",
  crawlerOptions: limit === undefined ? {} : { limit },
  scrapeOptions: baseScrapeOptions.parse({}),
  internalOptions: { teamId: "team", orgId: null },
  createdAt: 0,
});

describe("tryLockURL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks a URL the crawl has not visited", async () => {
    scard.mockResolvedValue(1);
    exec.mockResolvedValue([
      [null, 1],
      [null, 1],
    ]);

    expect(await tryLockURL("crawl", crawl(10), "https://example.com/a")).toBe(
      "locked",
    );
    expect(await lockURL("crawl", crawl(10), "https://example.com/b")).toBe(
      true,
    );
  });

  it("reports a URL that was already visited", async () => {
    exec.mockResolvedValue([
      [null, 0],
      [null, 1],
    ]);

    expect(await tryLockURL("crawl", crawl(), "https://example.com/a")).toBe(
      "already_visited",
    );
    expect(await lockURL("crawl", crawl(), "https://example.com/a")).toBe(
      false,
    );
  });

  it("reports a full crawl without touching the visited set", async () => {
    scard.mockResolvedValue(10);

    expect(await tryLockURL("crawl", crawl(10), "https://example.com/a")).toBe(
      "limit_reached",
    );
    expect(await lockURL("crawl", crawl(10), "https://example.com/a")).toBe(
      false,
    );
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("records no span per URL", async () => {
    exec.mockResolvedValue([
      [null, 1],
      [null, 1],
    ]);

    await tryLockURL("crawl", crawl(), "https://example.com/a");
    expect(withSpan).not.toHaveBeenCalled();
  });
});

describe("tryLockURL when Redis misbehaves", () => {
  const ok = [
    [null, 1],
    [null, 1],
  ];
  const silentLogger = createLogger({ silent: true });
  let loggedErrors = vi.spyOn(silentLogger, "error");

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    loggedErrors = vi.spyOn(silentLogger, "error");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a command error in the lock pipeline and keeps the lock", async () => {
    exec
      .mockResolvedValueOnce([
        [null, 1],
        [new Error("expire failed"), null],
      ])
      .mockResolvedValueOnce([
        [null, 0],
        [null, 1],
      ])
      .mockResolvedValueOnce(ok);

    const result = tryLockURL(
      "crawl",
      crawl(),
      "https://example.com/a",
      silentLogger,
    );
    await vi.runAllTimersAsync();

    // The retry reads SADD=0, but the first attempt had already added it.
    expect(await result).toBe("locked");
    expect(exec).toHaveBeenCalledTimes(3);
    expect(loggedErrors).toHaveBeenCalledTimes(1);
  });

  it("throws once the lock pipeline has been rejected three times", async () => {
    exec.mockRejectedValue(new Error("connection lost"));

    const result = tryLockURL(
      "crawl",
      crawl(),
      "https://example.com/a",
      silentLogger,
    );
    const assertion = expect(result).rejects.toThrow(
      "URL lock pipeline failed after retries",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(exec).toHaveBeenCalledTimes(3);
    expect(srem).not.toHaveBeenCalled();
  });

  it("rolls the lock back when the unique-URL bookkeeping keeps failing", async () => {
    exec
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce([
        [new Error("sadd failed"), null],
        [null, 1],
      ])
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(ok);

    const result = tryLockURL(
      "crawl",
      crawl(),
      "https://example.com/a",
      silentLogger,
    );
    const assertion = expect(result).rejects.toThrow(
      "Unique URL lock pipeline failed after retries",
    );
    await vi.runAllTimersAsync();
    await assertion;

    // One lock attempt, three bookkeeping attempts, one rollback.
    expect(exec).toHaveBeenCalledTimes(5);
    expect(srem).toHaveBeenCalledWith(
      "crawl:crawl:visited",
      "https://example.com/a",
    );
    expect(srem).toHaveBeenCalledWith(
      "crawl:crawl:visited_unique",
      "https://example.com/a",
    );
  });
});
