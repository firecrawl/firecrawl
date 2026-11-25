const mocks = vi.hoisted(() => ({
  addScrapeJob: vi.fn(),
  addScrapeJobs: vi.fn(),
  addScrapeJobToBullMQ: vi.fn(),
  getCrawl: vi.fn(),
  startWebScraperPipeline: vi.fn(),
  crawler: {
    robots: { getSitemaps: () => [] as string[] },
    usOnly: false,
    setBaseUrl: () => {},
    isRobotsAllowed: () => true,
    filterURL: async () => ({ allowed: true }),
    extractLinksFromContent: async () => [] as string[],
    filterLinks: vi.fn(),
  },
}));

vi.mock("../../../services/queue-jobs", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/queue-jobs")>()),
  addScrapeJob: mocks.addScrapeJob,
  addScrapeJobs: mocks.addScrapeJobs,
  _addScrapeJobToBullMQ: mocks.addScrapeJobToBullMQ,
}));
vi.mock("../../../lib/crawl-redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/crawl-redis")>()),
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
}));
vi.mock("../../../services/redis", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../services/redis")>()),
  redisEvictConnection: {
    scard: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn(),
    expire: vi.fn(),
    set: vi.fn(),
  },
}));
vi.mock("../../../lib/limits", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/limits")>()),
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

    await processJobInternal({
      id: "job-1",
      priority: 10,
      data: {
        url: "https://shop.test/p/1",
        mode: "single_urls",
        ctx,
        team_id: "team-1",
        crawl_id: "crawl-1",
        origin: SUBMITTER_ORIGIN,
        integration: "acme-integration",
        skipNuq: true,
        v1: true,
        scrapeOptions: { formats: [{ type: "markdown" }] },
        crawlerOptions: { currentDiscoveryDepth: 0 },
        internalOptions: { teamId: "team-1" },
      },
    } as any).catch(() => undefined);

    expect(mocks.addScrapeJob).toHaveBeenCalledTimes(1);
    const [data] = mocks.addScrapeJob.mock.calls[0];
    expect(data.url).toBe("https://shop.test/p/2");
    expect(data.origin).toBe(SUBMITTER_ORIGIN);
    expect(data.integration).toBe("acme-integration");
  });

  it("enqueues the sitemap kickoff under the crawl job's origin", async () => {
    await processJobInternal({
      id: "kickoff-1",
      priority: 10,
      data: {
        url: "https://shop.test/sitemap.xml",
        mode: "kickoff",
        ctx,
        team_id: "team-1",
        crawl_id: "crawl-1",
        origin: SUBMITTER_ORIGIN,
        integration: "acme-integration",
        skipNuq: true,
        v1: true,
        scrapeOptions: {},
        crawlerOptions: {},
      },
    } as any).catch(() => undefined);

    const sitemapJobs = mocks.addScrapeJobToBullMQ.mock.calls
      .map(([data]) => data)
      .filter(data => data.mode === "kickoff_sitemap");
    expect(sitemapJobs).toHaveLength(1);
    expect(sitemapJobs[0].sitemapUrl).toBe("https://shop.test/sitemap.xml");
    expect(sitemapJobs[0].origin).toBe(SUBMITTER_ORIGIN);
    expect(sitemapJobs[0].integration).toBe("acme-integration");
  });
});
