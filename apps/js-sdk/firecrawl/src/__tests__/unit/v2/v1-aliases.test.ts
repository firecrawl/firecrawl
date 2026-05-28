import { FirecrawlClient } from "../../../v2/client";

const ALIAS_MAP: Record<string, string> = {
  scrapeUrl: "scrape",
  crawlUrl: "crawl",
  asyncCrawlUrl: "startCrawl",
  checkCrawlStatus: "getCrawlStatus",
  checkCrawlErrors: "getCrawlErrors",
  mapUrl: "map",
  batchScrapeUrls: "batchScrape",
  asyncBatchScrapeUrls: "startBatchScrape",
  checkBatchScrapeStatus: "getBatchScrapeStatus",
  checkBatchScrapeErrors: "getBatchScrapeErrors",
};

describe("V1 deprecated aliases", () => {
  const app = new FirecrawlClient({
    apiKey: "fc-test",
    apiUrl: "http://localhost:9",
  });

  for (const [alias, target] of Object.entries(ALIAS_MAP)) {
    it(`${alias} delegates to ${target}`, async () => {
      const spy = jest
        .spyOn(app, target as any)
        .mockResolvedValue({ ok: true } as any);
      await (app as any)[alias]("https://example.com");
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  }
});
