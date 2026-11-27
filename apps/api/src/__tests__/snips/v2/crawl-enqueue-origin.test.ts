import type { BaseScrapeOptions } from "../../../controllers/v2/types";
import type { getCrawl } from "../../../lib/crawl-redis";
import type { resolveJobPriority } from "../../../lib/limits";
import type {
  _addScrapeJobToBullMQ,
  addScrapeJob,
} from "../../../services/queue-jobs";
import type { redisEvictConnection } from "../../../services/redis";
import type { NuQJob } from "../../../services/worker/nuq";
import type { ScrapeJobData, ScrapeJobKickoffSitemap } from "../../../types";

const mocks = vi.hoisted(() => ({
  addScrapeJob: vi.fn<typeof addScrapeJob>(),
  addScrapeJobs: vi.fn(),
  addScrapeJobToBullMQ: vi.fn<typeof _addScrapeJobToBullMQ>(),
  getCrawl: vi.fn(),
  startWebScraperPipeline: vi.fn(),
  redis: {
    scard: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
  },
  crawler: {
    robots: { getSitemaps: (): Array<string> => [] },
    usOnly: false,
    setBaseUrl: () => {},
    isRobotsAllowed: () => true,
    filterURL: async () => ({ allowed: true }),
    extractLinksFromContent: async (): Promise<Array<string>> => [],
    filterLinks: vi.fn(),
  },
}));

vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<{ addScrapeJob: typeof addScrapeJob }>()),
  addScrapeJob: mocks.addScrapeJob,
  addScrapeJobs: mocks.addScrapeJobs,
  _addScrapeJobToBullMQ: mocks.addScrapeJobToBullMQ,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<{ getCrawl: typeof getCrawl }>()),
  getCrawl: mocks.getCrawl,
  crawlToCrawler: () => mocks.crawler,
  lockURL: vi.fn().mockResolvedValue(true),
  lockURLsIndividually: vi.fn(
    async (_id: string, _sc: unknown, e: unknown) => e,
  ),
  addCrawlJob: vi.fn(),
  addCrawlJobs: vi.fn(),
  addCrawlJobDone: vi.fn(),
  queueCrawlJobDoneRepair: vi.fn(),
  saveCrawl: vi.fn(),
  recordRobotsBlocked: vi.fn(),
  recordThreatBlocked: vi.fn().mockResolvedValue(false),
  finishCrawlKickoff: vi.fn(),
  getCrawlJobs: vi.fn().mockResolvedValue([]),
  getDoneJobsOrderedLength: vi.fn().mockResolvedValue(0),
  isCrawlFinishMarked: vi.fn(async () => false),
}));
vi.mock("../../../services/redis", async importOriginal => ({
  ...(await importOriginal<{
    redisEvictConnection: typeof redisEvictConnection;
  }>()),
  redisEvictConnection: mocks.redis,
  redisCrawlStateConnection: mocks.redis,
  redisCrawlStateFallbackConnection: null,
}));
vi.mock("../../../lib/limits", async importOriginal => ({
  ...(await importOriginal<{
    resolveJobPriority: typeof resolveJobPriority;
  }>()),
  resolveJobPriority: vi.fn().mockResolvedValue(10),
}));
vi.mock("../../../main/runWebScraper", () => ({
  startWebScraperPipeline: mocks.startWebScraperPipeline,
}));

import { requestContext } from "../../../lib/request-context";
import { createService, replaceService } from "../../../service/service";
import { processJobInternal } from "../../../services/worker/scrape-worker";

const SUBMITTER_ORIGIN = "python-sdk@4.57.0";
const ctx = requestContext({ teamId: "team-1", zeroDataRetention: false });

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
    priority: 10,
    data,
  };
}

function storedCrawl() {
  return {
    ctx,
    team_id: "team-1",
    originUrl: "https://shop.test/",
    crawlerOptions: { limit: 100, maxDepth: 5 },
    scrapeOptions: {},
    internalOptions: { teamId: "team-1", zeroDataRetention: false },
    createdAt: Date.now(),
    zeroDataRetention: false,
    v1: true,
    origin: "js-sdk@4.56.0",
  };
}

describe("crawl enqueue origin", () => {
  beforeAll(() => {
    replaceService(
      createService(
        { modules: {} },
        { core: { name: "core" }, logger: { error: vi.fn() } },
      ),
    );
  });

  afterAll(() => {
    replaceService(undefined);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCrawl.mockResolvedValue(storedCrawl());
    mocks.crawler.filterLinks.mockResolvedValue({
      links: [],
      robotsBlocked: [],
      denialReasons: new Map(),
    });
  });

  it("enqueues discovered links under the crawl job's origin", async () => {
    mocks.crawler.filterLinks.mockResolvedValue({
      links: ["https://shop.test/p/2"],
      robotsBlocked: [],
      denialReasons: new Map(),
    });
    mocks.startWebScraperPipeline.mockResolvedValue({
      success: true,
      document: {
        rawHtml: '<a href="/p/2">next</a>',
        metadata: {
          url: "https://shop.test/p/1",
          sourceURL: "https://shop.test/p/1",
          statusCode: 200,
        },
      },
    });

    const outcome = await processJobInternal(
      makeNuqJob("job-1", {
        url: "https://shop.test/p/1",
        mode: "single_urls",
        ctx,
        team_id: "team-1",
        zeroDataRetention: false,
        crawl_id: "crawl-1",
        origin: SUBMITTER_ORIGIN,
        integration: "acme-integration",
        apiKeyId: null,
        skipNuq: true,
        v1: true,
        scrapeOptions: defaultScrapeOptions,
        crawlerOptions: { currentDiscoveryDepth: 0 },
        internalOptions: { teamId: "team-1", orgId: null },
      }),
    ).then(
      () => "resolved",
      (error: unknown) => `rejected: ${String(error)}`,
    );

    expect(mocks.addScrapeJob, outcome).toHaveBeenCalledTimes(1);
    expect(mocks.addScrapeJob.mock.calls[0][0]).toMatchObject({
      url: "https://shop.test/p/2",
      origin: SUBMITTER_ORIGIN,
      integration: "acme-integration",
    });
  });

  it("enqueues the sitemap kickoff under the crawl job's origin", async () => {
    const outcome = await processJobInternal(
      makeNuqJob("kickoff-1", {
        url: "https://shop.test/sitemap.xml",
        mode: "kickoff",
        ctx,
        team_id: "team-1",
        zeroDataRetention: false,
        crawl_id: "crawl-1",
        origin: SUBMITTER_ORIGIN,
        integration: "acme-integration",
        apiKeyId: null,
        skipNuq: true,
        v1: true,
        scrapeOptions: defaultScrapeOptions,
        crawlerOptions: {},
      }),
    ).then(
      () => "resolved",
      (error: unknown) => `rejected: ${String(error)}`,
    );

    const sitemapJobs = mocks.addScrapeJobToBullMQ.mock.calls
      .map(([data]) => data)
      .filter(
        (data: ScrapeJobData): data is ScrapeJobKickoffSitemap =>
          data.mode === "kickoff_sitemap",
      );
    expect(sitemapJobs, outcome).toHaveLength(1);
    expect(sitemapJobs[0].sitemapUrl).toBe("https://shop.test/sitemap.xml");
    expect(sitemapJobs[0].origin).toBe(SUBMITTER_ORIGIN);
    expect(sitemapJobs[0].integration).toBe("acme-integration");
  });
});
