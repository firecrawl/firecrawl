import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  search,
  searchRaw,
  idmux,
  Identity,
} from "./lib";

describeIf(TEST_PRODUCTION)("US-only teams", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "us-only/scrape",
      concurrency: 100,
      credits: 1000000,
      flags: { usOnly: true },
    });
  }, 10000 + scrapeTimeout);

  it.concurrent(
    "scrapes markdown and skips the query format with a warning",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            { type: "query", prompt: "What is Firecrawl?" },
          ],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.answer).toBeUndefined();
      expect(response.warning).toContain(
        "Query mode is not supported for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  it.concurrent(
    "skips the highlights format with a warning",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            { type: "highlights", query: "What is Firecrawl?" },
          ],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.highlights).toBeUndefined();
      expect(response.warning).toContain(
        "Query mode is not supported for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses X/Twitter URLs",
    async () => {
      const response = await scrapeRaw(
        { url: "https://x.com/NASA", timeout: scrapeTimeout },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        "X/Twitter scraping is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );
});

describeIf(TEST_PRODUCTION)("US-only teams: search", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "us-only/search",
      concurrency: 100,
      credits: 1000000,
      flags: { usOnly: true },
    });
  }, 10000 + scrapeTimeout);

  it.concurrent(
    "returns web results",
    async () => {
      const response = await search({ query: "firecrawl", limit: 5 }, identity);

      expect(response.web).toBeDefined();
      expect(response.web!.length).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "drops image results with a warning",
    async () => {
      const response = await searchRaw(
        {
          query: "firecrawl",
          limit: 5,
          sources: ["web", "images"],
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.web.length).toBeGreaterThan(0);
      expect(response.body.data.images ?? []).toHaveLength(0);
      expect(response.body.warning).toContain(
        "Image search is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses an image-only search",
    async () => {
      const response = await searchRaw(
        {
          query: "firecrawl",
          limit: 5,
          sources: ["images"],
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        "Image search is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );
});
