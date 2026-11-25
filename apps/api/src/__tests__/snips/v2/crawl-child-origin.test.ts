const mocks = vi.hoisted(() => ({
  scrapeURL: vi.fn(),
}));

vi.mock("../../../scraper/scrapeURL", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../scraper/scrapeURL")>()),
  scrapeURL: mocks.scrapeURL,
}));

import { startWebScraperPipeline } from "../../../main/runWebScraper";
import { CostTracking } from "../../../lib/cost-tracking";

describe("crawl and batch child scrape origin", () => {
  beforeEach(() => {
    mocks.scrapeURL.mockReset();
    mocks.scrapeURL.mockResolvedValue({
      success: true,
      document: { metadata: { statusCode: 200 } },
    });
  });

  it("scrapes a discovered crawl page under the crawl's origin, not the stored crawl options", async () => {
    await startWebScraperPipeline({
      job: {
        id: "job-1",
        priority: 10,
        data: {
          url: "https://shop.test/p/2",
          mode: "single_urls",
          team_id: "team-1",
          crawl_id: "crawl-1",
          origin: "python-sdk@4.57.0",
          scrapeOptions: { formats: [{ type: "markdown" }] },
          crawlerOptions: { currentDiscoveryDepth: 1 },
          internalOptions: { teamId: "team-1" },
        },
      } as any,
      costTracking: new CostTracking(),
    }).catch(() => undefined);

    expect(mocks.scrapeURL).toHaveBeenCalled();
    const internalOptions = mocks.scrapeURL.mock.calls[0][3];
    expect(internalOptions.origin).toBe("python-sdk@4.57.0");
  });
});
