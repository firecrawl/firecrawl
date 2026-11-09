import { afterEach, describe, expect, it, vi } from "vitest";
import type { AxiosAdapter } from "axios";
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [alias, target] of Object.entries(ALIAS_MAP)) {
    it(`${alias} delegates to ${target} and adds success: true`, async () => {
      const spy = vi
        .spyOn(app, target as any)
        .mockResolvedValue({ ok: true } as any);
      const result = await (app as any)[alias]("https://example.com");
      expect(spy).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, success: true });
    });
  }

  it("scrapeUrl keeps the document fields beside success, as v1 did", async () => {
    vi.spyOn(app, "scrape").mockResolvedValue({ markdown: "# hi", metadata: { sourceURL: "https://example.com" } } as any);
    const result = await app.scrapeUrl("https://example.com", { formats: ["markdown"] });
    expect(app.scrape).toHaveBeenCalledWith("https://example.com", { formats: ["markdown"] });
    expect(result.success).toBe(true);
    expect(result.markdown).toBe("# hi");
  });

  it("crawlUrl and asyncCrawlUrl rename v1 crawl options to their v2 names", async () => {
    vi.spyOn(app, "crawl").mockResolvedValue({ status: "completed", data: [] } as any);
    vi.spyOn(app, "startCrawl").mockResolvedValue({ id: "job-1", url: "u" } as any);
    const v1Options = { limit: 2, maxDepth: 3, allowBackwardLinks: true, ignoreSitemap: true, scrapeOptions: { formats: ["markdown" as const] } };
    const expected = { limit: 2, maxDiscoveryDepth: 3, crawlEntireDomain: true, sitemap: "skip", scrapeOptions: { formats: ["markdown"] } };

    await app.crawlUrl("https://example.com", v1Options);
    await app.asyncCrawlUrl("https://example.com", v1Options);

    expect(app.crawl).toHaveBeenCalledWith("https://example.com", expected);
    expect(app.startCrawl).toHaveBeenCalledWith("https://example.com", expected);
  });

  it("v2 methods return results without success", async () => {
    const client = new FirecrawlClient({ apiKey: "fc-test", apiUrl: "http://localhost:9" });
    const adapter: AxiosAdapter = async config => ({
      data: { success: true, data: { markdown: "# hi" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });
    (client as any).http.instance.defaults.adapter = adapter;
    const result = await client.scrape("https://example.com", { formats: ["markdown"] });
    expect(result).toEqual({ markdown: "# hi" });
    expect("success" in result).toBe(false);
  });
});

describe("V1 deprecation warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function freshClient() {
    vi.resetModules();
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const { FirecrawlClient: FreshClient } = await import("../../../v2/client");
    const app = new FreshClient({ apiKey: "fc-test", apiUrl: "http://localhost:9" });
    const v1Warnings = () => emitWarning.mock.calls.filter(([, opts]) => (opts as any)?.code === "FIRECRAWL_V1_METHOD");
    return { app, v1Warnings };
  }

  it("is emitted once per process", async () => {
    const { app, v1Warnings } = await freshClient();
    vi.spyOn(app, "scrape").mockResolvedValue({ markdown: "# hi" } as any);
    vi.spyOn(app, "map").mockResolvedValue({ links: [] } as any);

    await app.scrapeUrl("https://example.com");
    await app.scrapeUrl("https://example.com");
    await app.mapUrl("https://example.com");

    expect(v1Warnings()).toHaveLength(1);
    expect((v1Warnings()[0]![1] as any).type).toBe("DeprecationWarning");
  });

  it("is not emitted by v2 methods", async () => {
    const { app, v1Warnings } = await freshClient();
    const adapter: AxiosAdapter = async config => ({
      data: { success: true, data: { markdown: "# hi" } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });
    (app as any).http.instance.defaults.adapter = adapter;

    await app.scrape("https://example.com", { formats: ["markdown"] });

    expect(v1Warnings()).toHaveLength(0);
  });
});
