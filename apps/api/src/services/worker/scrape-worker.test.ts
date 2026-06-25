import type { NuQJob } from "./nuq";
import type { ScrapeJobData } from "../../types";
import { CrawlDenialError } from "../../lib/error";
import { processJobInternal } from "./scrape-worker";
import { addCrawlJobDone, getCrawl, normalizeURL } from "../../lib/crawl-redis";
import { redisEvictConnection } from "../redis";
import { startWebScraperPipeline } from "../../main/runWebScraper";

vi.mock("../../lib/scrape-job-permissions", () => ({
  checkScrapeJobPermissions: vi.fn(() => ({ error: "blocked" })),
}));

vi.mock("../../main/runWebScraper", () => ({
  startWebScraperPipeline: vi.fn(),
}));

vi.mock("../../lib/crawl-redis", () => ({
  addCrawlJobDone: vi.fn(async () => {}),
  getCrawl: vi.fn(async () => ({
    cancelled: false,
    scrapeOptions: {},
    crawlerOptions: {},
  })),
  normalizeURL: vi.fn((url: string) => url),
}));

vi.mock("../redis", () => ({
  redisEvictConnection: {
    srem: vi.fn(async () => 1),
  },
}));

vi.mock("../../lib/concurrency-limit", () => ({
  concurrentJobDone: vi.fn(async () => {}),
  pushConcurrencyLimitActiveJob: vi.fn(async () => {}),
}));

vi.mock("../../lib/job-priority", () => ({
  addJobPriority: vi.fn(async () => {}),
  deleteJobPriority: vi.fn(async () => {}),
  getJobPriority: vi.fn(async () => 10),
}));

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(async () => ({ flags: null })),
}));

vi.mock("../webhook/index", () => ({
  createWebhookSender: vi.fn(async () => null),
  WebhookEvent: {
    CRAWL_PAGE: "crawl.page",
    BATCH_SCRAPE_PAGE: "batch_scrape.page",
  },
}));

vi.mock("../logging/log_job", () => ({
  logScrape: vi.fn(async () => {}),
}));

vi.mock("../../lib/tracking", () => ({
  trackScrape: vi.fn(() => Promise.resolve()),
}));

vi.mock("../monitoring/results", () => ({
  recordMonitorScrapeFailure: vi.fn(async () => {}),
  recordMonitorScrapeSuccess: vi.fn(async () => {}),
}));

describe("processJobInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks crawl child jobs done when scrape preflight denies them", async () => {
    const job = {
      id: "scrape-1",
      status: "active",
      createdAt: new Date(),
      priority: 10,
      data: {
        mode: "single_urls",
        url: "https://www.linkedin.com/in/example",
        team_id: "team-1",
        crawlerOptions: {},
        scrapeOptions: {} as any,
        internalOptions: {
          teamId: "team-1",
          teamFlags: null,
          bypassBilling: true,
        },
        origin: "api",
        crawl_id: "crawl-1",
        zeroDataRetention: false,
        apiKeyId: null,
        skipNuq: true,
      },
    } as NuQJob<ScrapeJobData>;

    await expect(processJobInternal(job)).rejects.toThrow(CrawlDenialError);

    expect(startWebScraperPipeline).not.toHaveBeenCalled();
    expect(addCrawlJobDone).toHaveBeenCalledWith(
      "crawl-1",
      "scrape-1",
      false,
      expect.anything(),
    );
    expect(getCrawl).toHaveBeenCalledWith("crawl-1");
    expect(normalizeURL).toHaveBeenCalledWith(
      "https://www.linkedin.com/in/example",
      expect.anything(),
    );
    expect(redisEvictConnection.srem).toHaveBeenCalledWith(
      "crawl:crawl-1:visited_unique",
      "https://www.linkedin.com/in/example",
    );
    expect(redisEvictConnection.srem).toHaveBeenCalledWith(
      "crawl:crawl-1:jobs_qualified",
      "scrape-1",
    );
  });
});
