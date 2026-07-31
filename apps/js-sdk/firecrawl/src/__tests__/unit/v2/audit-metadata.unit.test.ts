import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";
import { startBatchScrape } from "../../../v2/methods/batch";
import { startCrawl } from "../../../v2/methods/crawl";
import { search } from "../../../v2/methods/search";
import { map } from "../../../v2/methods/map";
import { startExtract } from "../../../v2/methods/extract";
import { startAgent } from "../../../v2/methods/agent";

const auditMetadata = { username: "alice@example.com" };

function makeHttp(data: Record<string, unknown>) {
  const post = jest.fn(async () => ({ status: 200, data }));
  return {
    post,
    prepareHeaders: jest.fn(() => undefined),
  } as any;
}

describe("v2 auditMetadata request serialization", () => {
  test("scrape and batch scrape send metadata at the top level", async () => {
    const scrapeHttp = makeHttp({ success: true, data: {} });
    await scrape(scrapeHttp, "https://example.com", { auditMetadata });
    expect(scrapeHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ auditMetadata }),
    );

    const batchHttp = makeHttp({ success: true, id: "job", url: "u" });
    await startBatchScrape(batchHttp, ["https://example.com"], {
      options: { auditMetadata },
    });
    expect(batchHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ auditMetadata }),
    );
  });

  test("crawl, search, and extract send metadata under scrapeOptions", async () => {
    const crawlHttp = makeHttp({ success: true, id: "job", url: "u" });
    await startCrawl(crawlHttp, {
      url: "https://example.com",
      scrapeOptions: { auditMetadata },
    });
    expect(crawlHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ scrapeOptions: expect.objectContaining({ auditMetadata }) }),
    );

    const searchHttp = makeHttp({ success: true, data: {} });
    await search(searchHttp, {
      query: "example",
      scrapeOptions: { auditMetadata },
    });
    expect(searchHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ scrapeOptions: expect.objectContaining({ auditMetadata }) }),
    );

    const extractHttp = makeHttp({ success: true, id: "job" });
    await startExtract(extractHttp, {
      urls: ["https://example.com"],
      scrapeOptions: { auditMetadata },
    });
    expect(extractHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ scrapeOptions: expect.objectContaining({ auditMetadata }) }),
    );
  });

  test("map and agent send metadata at the top level", async () => {
    const mapHttp = makeHttp({ success: true, links: [] });
    await map(mapHttp, "https://example.com", { auditMetadata });
    expect(mapHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ auditMetadata }),
    );

    const agentHttp = makeHttp({ success: true, id: "job" });
    await startAgent(agentHttp, { prompt: "find pricing", auditMetadata });
    expect(agentHttp.post.mock.calls[0][1]).toEqual(
      expect.objectContaining({ auditMetadata }),
    );
  });
});
