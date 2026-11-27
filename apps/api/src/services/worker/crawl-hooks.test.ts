import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseScrapeOptions } from "../../controllers/v2/types";
import type { ScrapeJobData, ScrapeJobSingleUrls } from "../../types";
import type { NuQJob } from "./nuq";

type MockSpan = { readonly id?: string };

const mocks = vi.hoisted(() => {
  const crawler = {
    robots: { getSitemaps: vi.fn((): Array<string> => []) },
    usOnly: false,
    setBaseUrl: vi.fn(),
    isRobotsAllowed: vi.fn(() => true),
    filterURL: vi.fn(async () => ({ allowed: true })),
    extractLinksFromContent: vi.fn(async (): Promise<Array<string>> => []),
    filterLinks: vi.fn(async (links: Array<string>) => ({
      links,
      robotsBlocked: [] as Array<string>,
      denialReasons: new Map<string, string>(),
    })),
  };

  return {
    crawler,
    getCrawl: vi.fn(),
    crawlToCrawler: vi.fn(() => crawler),
    lockURL: vi.fn(async () => true),
    lockURLsIndividually: vi.fn(
      async (
        _crawlId: string,
        _sc: unknown,
        entries: Array<{ id: string; url: string }>,
      ) => entries,
    ),
    addCrawlJob: vi.fn(async () => undefined),
    addCrawlJobs: vi.fn(async () => undefined),
    addCrawlJobDone: vi.fn(async () => undefined),
    queueCrawlJobDoneRepair: vi.fn(async () => undefined),
    recordRobotsBlocked: vi.fn(async () => undefined),
    recordThreatBlocked: vi.fn(async () => false),
    finishCrawlKickoff: vi.fn(async () => undefined),
    finishCrawl: vi.fn(async () => undefined),
    getCrawlJobs: vi.fn(async (): Promise<Array<string>> => []),
    getDoneJobsOrderedLength: vi.fn(async () => 0),
    saveCrawl: vi.fn(async () => undefined),
    setCrawlError: vi.fn(async () => undefined),
    queryIndexAtSplitLevel: vi.fn(async (): Promise<Array<string>> => []),
    generateURLSplits: vi.fn((url: string) => [url]),
    scrapeSitemap: vi.fn(async () => ({
      urls: [] as Array<{ href: string }>,
      sitemaps: [] as Array<{ href: string }>,
    })),
    startWebScraperPipeline: vi.fn(),
    addScrapeJob: vi.fn(
      async (_data: ScrapeJobSingleUrls, _jobId?: string, _priority?: number) =>
        null,
    ),
    addScrapeJobs: vi.fn(
      async (
        _jobs: Array<{
          jobId: string;
          data: ScrapeJobSingleUrls;
          priority: number;
        }>,
      ) => true,
    ),
    addScrapeJobToBullMQ: vi.fn(async (..._args: Array<unknown>) => ({
      id: "sitemap-job",
    })),
    getACUCTeam: vi.fn(async () => ({ flags: null })),
    getJobs: vi.fn(
      async (): Promise<
        Array<{ timestamp: number; returnvalue: unknown }>
      > => [],
    ),
    readRequestCredits: vi.fn(async () => 5),
    readRequestCreditsFromAnalytics: vi.fn(async () => 5),
    logCrawl: vi.fn(async () => undefined),
    logBatchScrape: vi.fn(async () => undefined),
    logScrape: vi.fn(async () => undefined),
    createWebhookSender: vi.fn(async () => null),
    createInAppNotification: vi.fn(async () => true),
    checkUrlsAgainstThreatPolicy: vi.fn(
      async (
        urls: Array<string>,
      ): Promise<{
        allowedUrls: Array<string>;
        blocked: Array<unknown>;
        decisionsByUrl: Map<string, unknown>;
      }> => ({
        allowedUrls: urls,
        blocked: [],
        decisionsByUrl: new Map(),
      }),
    ),
    redisEvictConnection: {
      sadd: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      scard: vi.fn(async () => 0),
      set: vi.fn(async () => "OK"),
    },
  };
});

vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../../lib/concurrency-limit", () => ({
  concurrentJobDone: vi.fn(async () => undefined),
  pushConcurrencyLimitActiveJob: vi.fn(async () => undefined),
}));

vi.mock("../../scraper/scrapeURL/lib/cacheableLookup", () => ({
  cacheableLookup: { install: vi.fn() },
}));

vi.mock("../../lib/crawl-redis", () => ({
  addCrawlJob: mocks.addCrawlJob,
  addCrawlJobs: mocks.addCrawlJobs,
  addCrawlJobDone: mocks.addCrawlJobDone,
  crawlToCrawler: mocks.crawlToCrawler,
  queueCrawlJobDoneRepair: mocks.queueCrawlJobDoneRepair,
  recordRobotsBlocked: mocks.recordRobotsBlocked,
  recordThreatBlocked: mocks.recordThreatBlocked,
  finishCrawlKickoff: mocks.finishCrawlKickoff,
  finishCrawl: mocks.finishCrawl,
  getCrawlJobs: mocks.getCrawlJobs,
  getDoneJobsOrderedLength: mocks.getDoneJobsOrderedLength,
  isCrawlFinishMarked: vi.fn(async () => false),
  generateURLPermutations: (url: string) => [new URL(url)],
  getCrawl: mocks.getCrawl,
  lockURL: mocks.lockURL,
  lockURLsIndividually: mocks.lockURLsIndividually,
  normalizeURL: (url: string) => url,
  saveCrawl: mocks.saveCrawl,
  setCrawlError: mocks.setCrawlError,
}));

vi.mock("../redis", () => ({
  redisEvictConnection: mocks.redisEvictConnection,
  redisCrawlStateConnection: mocks.redisEvictConnection,
  redisCrawlStateFallbackConnection: null,
}));

vi.mock("../queue-jobs", () => ({
  _addScrapeJobToBullMQ: mocks.addScrapeJobToBullMQ,
  addScrapeJob: mocks.addScrapeJob,
  addScrapeJobs: mocks.addScrapeJobs,
}));

vi.mock("../webhook/index", () => ({
  createWebhookSender: mocks.createWebhookSender,
  WebhookEvent: {
    CRAWL_STARTED: "crawl.started",
    CRAWL_PAGE: "crawl.page",
    CRAWL_COMPLETED: "crawl.completed",
    BATCH_SCRAPE_PAGE: "batch_scrape.page",
    BATCH_SCRAPE_COMPLETED: "batch_scrape.completed",
  },
}));

vi.mock("../../main/runWebScraper", () => ({
  startWebScraperPipeline: mocks.startWebScraperPipeline,
}));

vi.mock("../../scraper/WebScraper/crawler", () => ({
  DenialReason: {
    ROBOTS_TXT: "robots",
  },
  WebCrawler: class {},
}));

vi.mock("../../scraper/crawler/sitemap", () => ({
  scrapeSitemap: mocks.scrapeSitemap,
}));

vi.mock("../../lib/otel-tracer", () => ({
  withTraceContextAsync: <T>(_ctx: unknown, fn: () => T): T => fn(),
  withZeroDataRetention: <T>(_zdr: boolean, fn: () => T): T => fn(),
  withSpan: <T>(_name: string, fn: (span: MockSpan) => T): T => fn({}),
  setSpanAttributes: vi.fn(),
}));

vi.mock("../../controllers/v2/crawl-status", () => ({
  getJobs: mocks.getJobs,
}));

import { requestContext } from "../../lib/request-context";
import type { CrawlFinished, HookHandlers } from "../../service/hooks";
import { createService, replaceService } from "../../service/service";
import { finishCrawlSuper } from "./crawl-logic";
import { processJobInternal } from "./scrape-worker";

const defaultScrapeOptions: BaseScrapeOptions = {
  formats: [{ type: "markdown" }],
  onlyMainContent: true,
  onlyCleanContent: false,
  waitFor: 0,
  mobile: false,
  removeBase64Images: true,
  fastMode: false,
  blockAds: true,
  proxy: "auto",
  checkPromptInjection: false,
};

function makeNuqJob<T extends ScrapeJobData>(id: string, data: T): NuQJob<T> {
  return {
    id,
    status: "active",
    createdAt: new Date(),
    priority: 0,
    data,
  };
}

function makeFinishData(overrides: {
  team_id: string;
  v1: boolean;
  zeroDataRetention: boolean;
}): ScrapeJobSingleUrls {
  return {
    mode: "single_urls",
    url: "https://example.com",
    origin: "api",
    apiKeyId: null,
    scrapeOptions: defaultScrapeOptions,
    ...overrides,
  };
}

function installHooks(hooks?: HookHandlers) {
  replaceService(
    createService(
      {
        modules: {},
        extensions: hooks ? [{ name: "test-hooks", hooks }] : [],
      },
      {
        core: { name: "core" },
        logger: { error: vi.fn() },
      },
    ),
  );
}

const baseStoredCrawl = () => ({
  originUrl: "https://example.com",
  crawlerOptions: { limit: 100, maxDepth: 5 },
  scrapeOptions: {},
  internalOptions: { zeroDataRetention: false },
  team_id: "team-1",
  createdAt: Date.now(),
  zeroDataRetention: false,
  cancelled: false,
  v1: true,
  ctx: requestContext({ teamId: "team-1", zeroDataRetention: false }),
});

describe("crawl lifecycle hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaceService(undefined);
    mocks.crawler.robots.getSitemaps.mockImplementation(() => []);
    mocks.crawler.extractLinksFromContent.mockResolvedValue([]);
    mocks.crawler.filterLinks.mockImplementation(
      async (links: Array<string>) => ({
        links,
        robotsBlocked: [],
        denialReasons: new Map(),
      }),
    );
    mocks.queryIndexAtSplitLevel.mockResolvedValue([]);
    mocks.scrapeSitemap.mockResolvedValue({ urls: [], sitemaps: [] });
    mocks.getDoneJobsOrderedLength.mockResolvedValue(3);
    mocks.getCrawlJobs.mockResolvedValue([]);
    mocks.getJobs.mockResolvedValue([]);
    mocks.checkUrlsAgainstThreatPolicy.mockImplementation(
      async (urls: Array<string>) => ({
        allowedUrls: urls,
        blocked: [],
        decisionsByUrl: new Map(),
      }),
    );
  });

  afterEach(() => {
    replaceService(undefined);
  });

  it("runs crawl.kickoff then crawl.links in order and transforms enqueued kickoff URLs", async () => {
    const order: Array<string> = [];
    installHooks({
      "crawl.kickoff": (urls, info) => {
        order.push(`kickoff:${info.id}:${info.url}:${info.ctx.teamId}`);
        return [
          ...urls,
          "https://example.com/seeded-keep",
          "https://example.com/seeded-drop",
        ];
      },
      "crawl.links": (links, info) => {
        order.push(`links:${info.id}:${info.from}`);
        return links.filter(url => !url.endsWith("-drop"));
      },
    });

    mocks.getCrawl.mockResolvedValue(baseStoredCrawl());

    const kickoffJob = makeNuqJob("kickoff-1", {
      mode: "kickoff",
      url: "https://example.com",
      crawl_id: "crawl-1",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
      crawlerOptions: { limit: 100 },
      scrapeOptions: defaultScrapeOptions,
      ctx: requestContext({ teamId: "team-1", zeroDataRetention: false }),
    });

    await processJobInternal(kickoffJob);

    expect(order).toEqual([
      "kickoff:crawl-1:https://example.com:team-1",
      "links:crawl-1:https://example.com",
    ]);
    expect(mocks.addScrapeJobs).toHaveBeenCalledTimes(1);
    const queuedUrls = mocks.addScrapeJobs.mock.calls[0][0].map(
      job => job.data.url,
    );
    expect(queuedUrls).toEqual(["https://example.com/seeded-keep"]);
  });

  it("transforms sitemap links through crawl.links with sitemapUrl as from", async () => {
    const seenFrom: Array<string> = [];
    installHooks({
      "crawl.links": (links, info) => {
        seenFrom.push(`${info.id}:${info.from}`);
        return links.filter(url => url.includes("/keep"));
      },
    });

    mocks.getCrawl.mockResolvedValue(baseStoredCrawl());
    mocks.scrapeSitemap.mockResolvedValue({
      urls: [
        { href: "https://example.com/keep" },
        { href: "https://example.com/blocked" },
      ],
      sitemaps: [],
    });

    const sitemapJob = makeNuqJob("sitemap-1", {
      mode: "kickoff_sitemap",
      crawl_id: "crawl-2",
      sitemapUrl: "https://example.com/sitemap.xml",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
      ctx: requestContext({ teamId: "team-1", zeroDataRetention: false }),
    });

    await processJobInternal(sitemapJob);

    expect(seenFrom).toEqual(["crawl-2:https://example.com/sitemap.xml"]);
    expect(mocks.addScrapeJobs).toHaveBeenCalledTimes(1);
    const queuedUrls = mocks.addScrapeJobs.mock.calls[0][0].map(
      job => job.data.url,
    );
    expect(queuedUrls).toEqual(["https://example.com/keep"]);
  });

  it("transforms page-discovered links through crawl.links during single_urls crawl scrapes", async () => {
    const seen: Array<{ id: string; from: string; count: number }> = [];
    installHooks({
      "crawl.links": (links, info) => {
        seen.push({ id: info.id, from: info.from, count: links.length });
        return links.filter(url => url !== "https://example.com/skip");
      },
    });

    mocks.getCrawl.mockResolvedValue(baseStoredCrawl());
    mocks.startWebScraperPipeline.mockResolvedValue({
      success: true,
      document: {
        markdown: "# Hello",
        rawHtml: "<a href='/next'>Next</a><a href='/skip'>Skip</a>",
        metadata: {
          url: "https://example.com/page",
          sourceURL: "https://example.com/page",
          statusCode: 200,
        },
      },
    });
    mocks.crawler.extractLinksFromContent.mockResolvedValue([
      "https://example.com/next",
      "https://example.com/skip",
    ]);

    const scrapeJob = makeNuqJob("scrape-1", {
      mode: "single_urls",
      url: "https://example.com/page",
      crawl_id: "crawl-3",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
      crawlerOptions: { limit: 100 },
      scrapeOptions: defaultScrapeOptions,
      ctx: requestContext({ teamId: "team-1", zeroDataRetention: false }),
    });

    await processJobInternal(scrapeJob);

    expect(seen).toEqual([
      { id: "crawl-3", from: "https://example.com/page", count: 2 },
    ]);
    expect(mocks.addScrapeJob).toHaveBeenCalledTimes(1);
    expect(mocks.addScrapeJob.mock.calls[0][0].url).toBe(
      "https://example.com/next",
    );
  });

  it("revalidates hook-added crawl.links URLs against crawler scope before queueing", async () => {
    installHooks({
      "crawl.links": links => [
        ...links,
        "https://out-of-scope.example.org/nope",
        "https://example.com/safe-added",
      ],
    });

    mocks.getCrawl.mockResolvedValue({
      ...baseStoredCrawl(),
      internalOptions: {
        zeroDataRetention: false,
      },
    });
    mocks.scrapeSitemap.mockResolvedValue({
      urls: [{ href: "https://example.com/from-sitemap" }],
      sitemaps: [],
    });
    mocks.crawler.filterLinks.mockImplementation(
      async (links: Array<string>) => ({
        links: links.filter(url => url.startsWith("https://example.com/")),
        robotsBlocked: [],
        denialReasons: new Map(),
      }),
    );

    const sitemapJob = makeNuqJob("sitemap-revalidate", {
      mode: "kickoff_sitemap",
      crawl_id: "crawl-revalidate",
      sitemapUrl: "https://example.com/sitemap.xml",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
      ctx: requestContext({ teamId: "team-1", zeroDataRetention: false }),
    });

    await processJobInternal(sitemapJob);

    expect(mocks.addScrapeJobs).toHaveBeenCalledTimes(1);
    expect(mocks.addScrapeJobs.mock.calls[0][0].map(j => j.data.url)).toEqual([
      "https://example.com/from-sitemap",
      "https://example.com/safe-added",
    ]);
  });

  it("awaits crawl.finished for both crawl and batchScrape (v1 and v0) and propagates rejections", async () => {
    const events: Array<CrawlFinished> = [];
    installHooks({
      "crawl.finished": async event => {
        events.push(event);
      },
    });

    // v1 crawl with shed job.data (ZDR)
    mocks.getCrawl.mockResolvedValueOnce({
      ...baseStoredCrawl(),
      zeroDataRetention: true,
      ctx: requestContext({ teamId: "team-1", zeroDataRetention: true }),
      cancelled: false,
      v1: true,
    });
    mocks.getDoneJobsOrderedLength.mockResolvedValueOnce(4);

    await finishCrawlSuper({
      id: "fin-1",
      groupId: "crawl-v1",
      data: null,
    });

    // v0 batch scrape
    mocks.getCrawl.mockResolvedValueOnce({
      ...baseStoredCrawl(),
      crawlerOptions: null,
      cancelled: true,
      v1: false,
    });
    mocks.getCrawlJobs.mockResolvedValueOnce(["child-1"]);
    mocks.getJobs.mockResolvedValueOnce([
      { timestamp: 1, returnvalue: { markdown: "doc", metadata: {} } },
    ]);

    await finishCrawlSuper({
      id: "fin-2",
      groupId: "batch-v0",
      data: makeFinishData({
        team_id: "team-1",
        v1: false,
        zeroDataRetention: false,
      }),
    });

    expect(events).toEqual([
      expect.objectContaining({
        id: "crawl-v1",
        kind: "crawl",
        ctx: expect.objectContaining({
          teamId: "team-1",
          zeroDataRetention: true,
        }),
        completed: 4,
        cancelled: false,
      }),
      expect.objectContaining({
        id: "batch-v0",
        kind: "batchScrape",
        ctx: expect.objectContaining({
          teamId: "team-1",
          zeroDataRetention: false,
        }),
        completed: 1,
        cancelled: true,
      }),
    ]);

    // Handler rejection propagates (await semantics)
    installHooks({
      "crawl.finished": async () => {
        throw new Error("finalize hook failed");
      },
    });
    mocks.getCrawl.mockResolvedValueOnce(baseStoredCrawl());
    await expect(
      finishCrawlSuper({
        id: "fin-3",
        groupId: "crawl-err",
        data: makeFinishData({
          team_id: "team-1",
          v1: true,
          zeroDataRetention: false,
        }),
      }),
    ).rejects.toThrow("finalize hook failed");
  });

  it("leaves crawl kickoff, sitemap, page discovery, and finalization unchanged with no service or no handlers", async () => {
    mocks.getCrawl.mockResolvedValue(baseStoredCrawl());

    const kickoffJob = makeNuqJob("kickoff-plain", {
      mode: "kickoff",
      url: "https://example.com",
      crawl_id: "crawl-plain",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
      crawlerOptions: { limit: 100 },
      scrapeOptions: defaultScrapeOptions,
    });

    await processJobInternal(kickoffJob);
    expect(mocks.addScrapeJobs).not.toHaveBeenCalled();

    mocks.scrapeSitemap.mockResolvedValue({
      urls: [{ href: "https://example.com/sitemap-plain" }],
      sitemaps: [],
    });
    const sitemapJob = makeNuqJob("sitemap-plain", {
      mode: "kickoff_sitemap",
      crawl_id: "crawl-plain",
      sitemapUrl: "https://example.com/sitemap.xml",
      team_id: "team-1",
      zeroDataRetention: false,
      origin: "api",
      v1: true,
      apiKeyId: 1,
    });
    await processJobInternal(sitemapJob);
    expect(mocks.addScrapeJobs.mock.calls[0][0].map(j => j.data.url)).toEqual([
      "https://example.com/sitemap-plain",
    ]);

    installHooks();
    mocks.startWebScraperPipeline.mockResolvedValue({
      success: true,
      document: {
        markdown: "# Plain",
        rawHtml: "<a href='/discovered'>Discovered</a>",
        metadata: {
          url: "https://example.com/page",
          sourceURL: "https://example.com/page",
          statusCode: 200,
        },
      },
    });
    mocks.crawler.extractLinksFromContent.mockResolvedValue([
      "https://example.com/discovered",
    ]);
    await processJobInternal(
      makeNuqJob("scrape-plain", {
        mode: "single_urls",
        url: "https://example.com/page",
        crawl_id: "crawl-plain",
        team_id: "team-1",
        zeroDataRetention: false,
        origin: "api",
        v1: true,
        apiKeyId: 1,
        crawlerOptions: { limit: 100 },
        scrapeOptions: defaultScrapeOptions,
      }),
    );
    expect(mocks.addScrapeJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: "https://example.com/discovered" }),
      expect.any(String),
      expect.any(Number),
    );

    await expect(
      finishCrawlSuper({
        id: "fin-plain",
        groupId: "crawl-plain",
        data: makeFinishData({
          team_id: "team-1",
          v1: true,
          zeroDataRetention: false,
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
