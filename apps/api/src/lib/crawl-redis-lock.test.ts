import { vi } from "vitest";

const { scard, exec, pipeline, withSpan } = vi.hoisted(() => {
  const exec = vi.fn();
  const chain = {
    sadd: vi.fn(() => chain),
    expire: vi.fn(() => chain),
    srem: vi.fn(() => chain),
    exec,
  };
  return {
    scard: vi.fn(),
    exec,
    pipeline: vi.fn(() => chain),
    withSpan: vi.fn(
      async (_name: string, fn: (span: any) => any) => await fn({}),
    ),
  };
});

vi.mock("../services/redis", () => ({
  redisEvictConnection: { scard, pipeline },
}));
vi.mock("../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));
vi.mock("./otel-tracer", () => ({
  withSpan,
  setSpanAttributes: vi.fn(),
  withZeroDataRetention: (_zdr: unknown, fn: () => unknown) => fn(),
}));

import { lockURL, tryLockURL, type StoredCrawl } from "./crawl-redis";

const crawl = (limit?: number) =>
  ({
    team_id: "team",
    crawlerOptions: limit === undefined ? {} : { limit },
    scrapeOptions: {},
    internalOptions: {},
    createdAt: 0,
  }) as unknown as StoredCrawl;

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
