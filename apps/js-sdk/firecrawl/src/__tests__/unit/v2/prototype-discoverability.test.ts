import { describe, it, expect } from "vitest";
import { Firecrawl, FirecrawlClient } from "../../../index";

describe("V2 prototype discoverability", () => {
  const app = new Firecrawl({ apiKey: "fc-test", apiUrl: "http://localhost:9" });

  it("exposes V2 methods on immediate Firecrawl prototype", () => {
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(app));

    expect(names).toEqual(
      expect.arrayContaining([
        "scrape",
        "search",
        "map",
        "crawl",
        "startCrawl",
        "getCrawlStatus",
        "batchScrape",
      ])
    );
  });

  it("copied descriptors are identical to V2 prototype originals", () => {
    for (const name of ["scrape", "search", "crawl", "map", "startCrawl"]) {
      const firecrawlDesc = Object.getOwnPropertyDescriptor(Firecrawl.prototype, name);
      const v2Desc = Object.getOwnPropertyDescriptor(FirecrawlClient.prototype, name);
      expect(firecrawlDesc).toBeDefined();
      expect(firecrawlDesc!.value).toBe(v2Desc!.value);
    }
  });

  it("copied method resolves this to the Firecrawl instance", async () => {
    const method = Object.getOwnPropertyDescriptor(Firecrawl.prototype, "scrape")!.value;
    await expect(method.call(app, "https://example.com")).rejects.toThrow();
  });
});
