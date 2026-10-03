import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import axios from "axios";
import FirecrawlApp from "../../../v1";

const API_URL = "https://api.firecrawl.dev";

class FakeWebSocket {
  onopen: unknown = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  onclose: unknown = null;
  close() {}
}

describe("v1 methods work without params", () => {
  let app: FirecrawlApp;
  let posts: Array<{ url: string; data: any }>;
  const originalWebSocket = (globalThis as any).WebSocket;

  beforeEach(() => {
    app = new FirecrawlApp({ apiKey: "fc-test", apiUrl: API_URL });
    posts = [];
    jest.spyOn(axios, "post").mockImplementation(async (url: string, data?: any) => {
      posts.push({ url, data });
      return { status: 200, data: { success: true, id: "job-1", data: [], links: [] } };
    });
    jest.spyOn(axios, "get").mockImplementation(async () => ({
      status: 200,
      data: { success: true, status: "completed", data: [{ markdown: "ok" }] },
    }));
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (globalThis as any).WebSocket = originalWebSocket;
  });

  const cases: Array<[string, string, (app: any) => Promise<unknown>]> = [
    ["scrapeUrl", "/v1/scrape", app => app.scrapeUrl("https://example.com")],
    ["search", "/v1/search", app => app.search("firecrawl")],
    ["crawlUrl", "/v1/crawl", app => app.crawlUrl("https://example.com")],
    ["asyncCrawlUrl", "/v1/crawl", app => app.asyncCrawlUrl("https://example.com")],
    ["crawlUrlAndWatch", "/v1/crawl", app => app.crawlUrlAndWatch("https://example.com")],
    ["mapUrl", "/v1/map", app => app.mapUrl("https://example.com")],
    ["batchScrapeUrls", "/v1/batch/scrape", app => app.batchScrapeUrls(["https://example.com"])],
    ["asyncBatchScrapeUrls", "/v1/batch/scrape", app => app.asyncBatchScrapeUrls(["https://example.com"])],
    ["batchScrapeUrlsAndWatch", "/v1/batch/scrape", app => app.batchScrapeUrlsAndWatch(["https://example.com"])],
    ["extract", "/v1/extract", app => app.extract(["https://example.com"])],
    ["asyncExtract", "/v1/extract", app => app.asyncExtract(["https://example.com"])],
    ["deepResearch", "/v1/deep-research", app => app.deepResearch("firecrawl")],
    ["asyncDeepResearch", "/v1/deep-research", app => app.asyncDeepResearch("firecrawl")],
    ["__deepResearch", "/v1/deep-research", app => app.__deepResearch("firecrawl")],
    ["__asyncDeepResearch", "/v1/deep-research", app => app.__asyncDeepResearch("firecrawl")],
    ["generateLLMsText", "/v1/llmstxt", app => app.generateLLMsText("https://example.com")],
    ["asyncGenerateLLMsText", "/v1/llmstxt", app => app.asyncGenerateLLMsText("https://example.com")],
  ];

  test.each(cases)("%s sends the default origin", async (_method, path, call) => {
    await expect(call(app)).resolves.toBeDefined();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${API_URL}${path}`);
    expect(posts[0].data.origin).toBe(`js-sdk@${app.version}`);
  });

  test("an mcp origin passed in params is still forwarded", async () => {
    await app.batchScrapeUrls(["https://example.com"], { origin: "mcp-server" } as any);
    expect(posts[0].data.origin).toBe("mcp-server");
  });
});
