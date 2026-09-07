import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";
import { startBatchScrape } from "../../../v2/methods/batch";
import { startCrawl } from "../../../v2/methods/crawl";

function makeHttp(data: Record<string, unknown>) {
  const post = jest.fn(async () => ({ status: 200, data }));
  return {
    post,
    prepareHeaders: jest.fn(() => undefined),
  } as any;
}

describe("v2 onlyCleanContent request serialization", () => {
  test("scrape and batch scrape send onlyCleanContent at the top level", async () => {
    const scrapeHttp = makeHttp({ success: true, data: {} });
    await scrape(scrapeHttp, "https://example.com", { onlyCleanContent: true });
    expect(scrapeHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ onlyCleanContent: true }),
    );

    const batchHttp = makeHttp({ success: true, id: "job", url: "u" });
    await startBatchScrape(batchHttp, ["https://example.com"], {
      options: { onlyCleanContent: true },
    });
    expect(batchHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ onlyCleanContent: true }),
    );
  });

  test("crawl sends onlyCleanContent under scrapeOptions", async () => {
    const crawlHttp = makeHttp({ success: true, id: "job", url: "u" });
    await startCrawl(crawlHttp, {
      url: "https://example.com",
      scrapeOptions: { onlyCleanContent: true },
    });
    expect(crawlHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        scrapeOptions: expect.objectContaining({ onlyCleanContent: true }),
      }),
    );
  });
});
