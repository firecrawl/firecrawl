import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  scrape: vi.fn(),
  process: vi.fn(),
  parse: vi.fn(),
  exec: vi.fn(),
  sadd: vi.fn(),
  expire: vi.fn(),
  log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../scraper/scrapeURL", () => ({ scrapeURL: mock.scrape }));
vi.mock("../../../config", () => ({ config: {} }));
vi.mock("../../../controllers/v2/types", () => ({
  scrapeOptions: { parse: (value: unknown) => value },
}));
vi.mock("../../../lib/cost-tracking", () => ({ CostTracking: class {} }));
vi.mock("../../../lib/logger", () => ({ logger: { child: () => mock.log } }));
vi.mock("../../../services/redis", () => ({
  redisEvictConnection: {
    pipeline: () => {
      const pipeline = { sadd: () => pipeline, exec: mock.exec };
      return pipeline;
    },
    sadd: mock.sadd,
    expire: mock.expire,
  },
}));
vi.mock("../../../services", () => ({ useIndex: false }));
vi.mock("../../scrapeURL/engines/fire-engine/available", () => ({
  useFireEngine: false,
}));
vi.mock("../../scrapeURL/engines/utils/downloadFile", () => ({
  fetchFileToBuffer: vi.fn(),
}));
vi.mock("../../../lib/robots-txt", () => ({
  fetchRobotsTxt: vi.fn(),
  createRobotsChecker: vi.fn(),
  isUrlAllowedByRobots: () => true,
}));
vi.mock("@mendable/firecrawl-rs", () => ({
  processSitemap: mock.process,
  parseSitemapXml: mock.parse,
  extractLinks: vi.fn(),
  filterLinks: vi.fn(),
  filterUrl: vi.fn(),
}));
import { WebCrawler } from "../crawler";
import { getLinksFromSitemap } from "../sitemap";

beforeEach(() => {
  vi.resetAllMocks();
  mock.scrape.mockResolvedValue({
    success: true,
    document: { metadata: { statusCode: 200 }, rawHtml: "xml" },
  });
  mock.process.mockResolvedValue({
    instructions: [{ action: "process", urls: ["https://example.com/page"] }],
  });
  mock.exec.mockResolvedValue([[null, 1]]);
  mock.sadd.mockResolvedValue(0);
  mock.expire.mockResolvedValue(1);
});
function crawler() {
  const value = new WebCrawler({
    jobId: "test",
    initialUrl: "https://example.com",
  });
  vi.spyOn(value, "filterLinks").mockImplementation(async urls => ({
    links: urls,
    denialReasons: new Map(),
  }));
  return value;
}
it("propagates the original deduplication command failure through all sitemap callers", async () => {
  const error = new Error("WRONGTYPE dedup");
  mock.exec.mockResolvedValue([[error, null]]);
  await expect(crawler().tryGetSitemap(vi.fn())).rejects.toBe(error);
});
it("propagates rejected URL handler promises through recursive sitemap processing", async () => {
  const error = new Error("Redis handler failed");
  mock.process.mockResolvedValueOnce({
    instructions: [
      { action: "recurse", urls: ["https://example.com/child.xml"] },
    ],
  });
  await expect(
    getLinksFromSitemap(
      {
        sitemapUrl: "https://example.com/sitemap.xml",
        urlsHandler: async () => {
          throw error;
        },
        zeroDataRetention: false,
      },
      mock.log as never,
      "test",
      new Set(),
    ),
  ).rejects.toBe(error);
});
it("propagates handler failures through the parser fallback", async () => {
  const error = new Error("Redis handler failed");
  mock.process.mockRejectedValue(new Error("parser fallback"));
  mock.parse.mockResolvedValue({
    urlset: { url: [{ loc: ["https://example.com/page"] }] },
  });
  await expect(
    crawler().tryGetSitemap(
      async () => {
        throw error;
      },
      true,
      true,
    ),
  ).rejects.toBe(error);
});
it("keeps missing-sitemap HTTP fallback", async () => {
  mock.scrape.mockResolvedValue({
    success: true,
    document: { metadata: { statusCode: 404 } },
  });
  await expect(crawler().tryGetSitemap(vi.fn())).resolves.toBe(0);
});
it("awaits the initial URL handler and preserves its original rejection", async () => {
  const error = new Error("initial URL failed");
  mock.sadd.mockResolvedValue(1);
  await expect(
    crawler().tryGetSitemap(async urls => {
      if (urls[0] === "https://example.com") throw error;
    }),
  ).rejects.toBe(error);
});
it("propagates final expiry failure even when no sitemap exists", async () => {
  const error = new Error("expiry failed");
  mock.scrape.mockResolvedValue({
    success: true,
    document: { metadata: { statusCode: 404 } },
  });
  mock.expire.mockRejectedValue(error);
  await expect(crawler().tryGetSitemap(vi.fn())).rejects.toBe(error);
});

it("awaits an in-flight Redis callback after sitemap timeout and rejects its original error", async () => {
  vi.useFakeTimers();
  try {
    const error = new Error("late Redis deduplication failure");
    let finish!: (value: unknown) => void;
    mock.exec.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const result = crawler().tryGetSitemap(vi.fn(), false, false, 10);
    const rejection = expect(result).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.exec).toHaveBeenCalledOnce();
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    finish([[error, null]]);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
});

it("returns the timeout fallback without waiting for a fetch and ignores its later callbacks", async () => {
  vi.useFakeTimers();
  try {
    const value = crawler();
    let lateHandler!: (urls: string[]) => unknown;
    let finish!: (value: number) => void;
    vi.spyOn(
      value as unknown as {
        tryFetchSitemapLinks(
          source: string,
          handler: (urls: string[]) => unknown,
        ): Promise<number>;
      },
      "tryFetchSitemapLinks",
    ).mockImplementation((_source, handler) => {
      lateHandler = handler;
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const handler = vi.fn();
    const result = value.tryGetSitemap(handler, false, false, 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(0);
    await lateHandler(["https://example.com/late"]);
    finish(0);
    expect(mock.exec).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("returns zero and skips the initial URL after caller cancellation discards sitemap URLs", async () => {
  const abort = new AbortController();
  mock.process.mockImplementation(async () => {
    abort.abort();
    return {
      instructions: [{ action: "process", urls: ["https://example.com/page"] }],
    };
  });
  mock.sadd.mockResolvedValue(1);
  const handler = vi.fn();
  await expect(
    crawler().tryGetSitemap(handler, false, false, 1000, abort.signal),
  ).resolves.toBe(0);
  expect(mock.exec).not.toHaveBeenCalled();
  expect(mock.sadd).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(mock.expire).toHaveBeenCalledWith("sitemap:test:links", 3600, "NX");
});

it("skips initial URL dispatch if caller cancellation occurs during its Redis write", async () => {
  const abort = new AbortController();
  mock.sadd.mockImplementation(async () => {
    abort.abort();
    return 1;
  });
  const handler = vi.fn();
  await expect(
    crawler().tryGetSitemap(handler, false, false, 1000, abort.signal),
  ).resolves.toBe(0);
  expect(handler).toHaveBeenCalledOnce();
  expect(handler).toHaveBeenCalledWith(["https://example.com/page"]);
  expect(mock.expire).toHaveBeenCalledWith("sitemap:test:links", 3600, "NX");
});

it("expires a partially written sitemap when a pipeline command fails", async () => {
  const error = new Error("partial pipeline failure");
  mock.exec.mockResolvedValue([
    [null, 1],
    [error, null],
  ]);
  await expect(crawler().tryGetSitemap(vi.fn())).rejects.toBe(error);
  expect(mock.expire).toHaveBeenCalledWith("sitemap:test:links", 3600, "NX");
});

it("expires the sitemap after the initial URL handler fails", async () => {
  const error = new Error("initial handler failed");
  mock.sadd.mockResolvedValue(1);
  await expect(
    crawler().tryGetSitemap(async urls => {
      if (urls[0] === "https://example.com") throw error;
    }),
  ).rejects.toBe(error);
  expect(mock.expire).toHaveBeenCalledTimes(2);
});

it("preserves both a sitemap failure and its expiry failure", async () => {
  const primary = new Error("partial pipeline failure");
  const expiry = new Error("expiry failure");
  mock.exec.mockResolvedValue([
    [null, 1],
    [primary, null],
  ]);
  mock.expire.mockRejectedValue(expiry);
  await expect(crawler().tryGetSitemap(vi.fn())).rejects.toMatchObject({
    errors: [primary, expiry],
  });
});

it("expires a successful sitemap before returning its count", async () => {
  await expect(crawler().tryGetSitemap(vi.fn())).resolves.toBe(2);
  expect(mock.expire).toHaveBeenCalledTimes(2);
});
