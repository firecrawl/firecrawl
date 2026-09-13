import { describe, test, expect, jest } from "@jest/globals";
import { scrape } from "../../../v2/methods/scrape";
import { startBatchScrape } from "../../../v2/methods/batch";
import { startCrawl } from "../../../v2/methods/crawl";
import { search } from "../../../v2/methods/search";
import { map } from "../../../v2/methods/map";
import { startExtract } from "../../../v2/methods/extract";
import { startAgent } from "../../../v2/methods/agent";
import type { ThreatProtectionOptions } from "../../../v2/types";

const threatProtection: ThreatProtectionOptions = {
  mode: "normal",
  riskScoreThreshold: 80,
  blacklist: ["*.blocked.example.com"],
  whitelist: ["allowed.example.com"],
  blockedTlds: ["zip"],
  failurePolicy: "open",
};

function makeHttp(data: Record<string, unknown>) {
  const post = jest.fn(async () => ({ status: 200, data }));
  return {
    post,
    prepareHeaders: jest.fn(() => undefined),
  } as any;
}

describe("v2 threatProtection request serialization", () => {
  test("scrape sends threatProtection at top level", async () => {
    const http = makeHttp({ success: true, data: {} });
    await scrape(http, "https://example.com", { threatProtection });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/scrape",
      expect.objectContaining({ url: "https://example.com", threatProtection }),
      {},
    );
  });

  test("scrape sends domainTools when true", async () => {
    const http = makeHttp({ success: true, data: {} });
    await scrape(http, "https://example.com", { domainTools: true });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/scrape",
      expect.objectContaining({ url: "https://example.com", domainTools: true }),
      expect.anything(),
    );
  });

  test("batch scrape sends threatProtection at top level", async () => {
    const http = makeHttp({ success: true, id: "job", url: "u" });
    await startBatchScrape(http, ["https://example.com"], {
      options: { threatProtection },
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/batch/scrape",
      expect.objectContaining({
        urls: ["https://example.com"],
        threatProtection,
      }),
      expect.anything(),
    );
  });

  test("crawl sends threatProtection under scrapeOptions", async () => {
    const http = makeHttp({ success: true, id: "job", url: "u" });
    await startCrawl(http, {
      url: "https://example.com",
      scrapeOptions: { threatProtection },
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/crawl",
      expect.objectContaining({
        scrapeOptions: expect.objectContaining({ threatProtection }),
      }),
    );
  });

  test("search sends threatProtection at top level and under scrapeOptions", async () => {
    const http = makeHttp({ success: true, data: {} });
    await search(http, {
      query: "firecrawl",
      threatProtection,
      scrapeOptions: { threatProtection },
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      expect.objectContaining({
        threatProtection,
        scrapeOptions: expect.objectContaining({ threatProtection }),
      }),
      {},
    );
  });

  test("map sends threatProtection at top level", async () => {
    const http = makeHttp({ success: true, links: [] });
    await map(http, "https://example.com", { threatProtection });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/map",
      expect.objectContaining({ threatProtection }),
      {},
    );
  });

  test("extract sends threatProtection at top level", async () => {
    const http = makeHttp({ success: true, id: "job" });
    await startExtract(http, {
      urls: ["https://example.com"],
      prompt: "extract",
      threatProtection,
    });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/extract",
      expect.objectContaining({ threatProtection }),
    );
  });

  test("agent sends threatProtection at top level", async () => {
    const http = makeHttp({ success: true, id: "job", status: "processing" });
    await startAgent(http, { prompt: "find pricing", threatProtection });
    expect(http.post).toHaveBeenCalledWith(
      "/v2/agent",
      expect.objectContaining({ threatProtection }),
    );
  });

  test("threatProtection is omitted when not provided", async () => {
    const http = makeHttp({ success: true, data: {} });
    await scrape(http, "https://example.com", { onlyMainContent: true });
    const body = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("threatProtection");
  });
});
