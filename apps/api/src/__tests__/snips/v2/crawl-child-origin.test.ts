import type { BaseScrapeOptions } from "../../../controllers/v2/types";
import type { scrapeURL } from "../../../scraper/scrapeURL";
import type { NuQJob } from "../../../services/worker/nuq";
import type { ScrapeJobSingleUrls } from "../../../types";

const mocks = vi.hoisted(() => ({
  scrapeURL: vi.fn(async (..._args: Parameters<typeof scrapeURL>) => ({
    success: true,
    document: { metadata: { statusCode: 200 } },
  })),
}));

vi.mock("../../../scraper/scrapeURL", async importOriginal => ({
  ...(await importOriginal<{ scrapeURL: typeof scrapeURL }>()),
  scrapeURL: mocks.scrapeURL,
}));

import { startWebScraperPipeline } from "../../../main/runWebScraper";
import { CostTracking } from "../../../lib/cost-tracking";

const scrapeOptions: BaseScrapeOptions = {
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

const crawlPageJob: NuQJob<ScrapeJobSingleUrls> = {
  id: "job-1",
  status: "active",
  createdAt: new Date(),
  priority: 10,
  data: {
    url: "https://shop.test/p/2",
    mode: "single_urls",
    team_id: "team-1",
    zeroDataRetention: false,
    crawl_id: "crawl-1",
    origin: "python-sdk@4.57.0",
    apiKeyId: null,
    scrapeOptions,
    crawlerOptions: { currentDiscoveryDepth: 1 },
    internalOptions: { teamId: "team-1", orgId: null },
  },
};

describe("crawl and batch child scrape origin", () => {
  beforeEach(() => {
    mocks.scrapeURL.mockClear();
  });

  it("scrapes a discovered crawl page under the crawl's origin, not the stored crawl options", async () => {
    await startWebScraperPipeline({
      job: crawlPageJob,
      costTracking: new CostTracking(),
    }).catch(() => undefined);

    expect(mocks.scrapeURL).toHaveBeenCalled();
    const internalOptions = mocks.scrapeURL.mock.calls[0][3];
    expect(internalOptions.origin).toBe("python-sdk@4.57.0");
  });
});
