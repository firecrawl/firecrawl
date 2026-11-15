import { describeIf, itIf, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  search,
  searchRaw,
  idmux,
  Identity,
  crawlStart,
  extractRaw,
  EXTRACT_LIVE,
  map,
  browserCreateRaw,
} from "./lib";
import { config } from "../../../config";

// Without the US OpenAI key, every OpenAI-backed feature is refused for
// US-only teams.
const HAS_US_OPENAI = !!config.OPENAI_US_API_KEY;

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
    "skips the audio and video formats with warnings",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "audio", "video"],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.warning).toContain(
        "Audio format is not supported for teams restricted to US-only processing.",
      );
      expect(response.warning).toContain(
        "Video format is not supported for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  itIf(HAS_US_OPENAI)(
    "extracts JSON through the US route",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "json",
              prompt: "Extract the company name.",
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          ],
        },
        identity,
      );

      expect(response.json).toBeDefined();
      expect(typeof response.json.name).toBe("string");
    },
    scrapeTimeout,
  );

  itIf(!HAS_US_OPENAI)(
    "refuses the JSON format without a US route",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", { type: "json", prompt: "Extract the title." }],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        "JSON format is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  itIf(!HAS_US_OPENAI)(
    "refuses the summary format without a US route",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown", "summary"],
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        "Summary format is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  itIf(!HAS_US_OPENAI)(
    "refuses a crawl prompt without a US route",
    async () => {
      const response = await crawlStart(
        { url: "https://firecrawl.dev", prompt: "Only the blog pages." },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
    },
    scrapeTimeout,
  );

  itIf(EXTRACT_LIVE && !HAS_US_OPENAI)(
    "refuses extract without a US route",
    async () => {
      const response = await extractRaw(
        {
          urls: ["https://firecrawl.dev"],
          prompt: "Extract the company name.",
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        "Extract is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );

  it.concurrent(
    "scrapes with a US location",
    async () => {
      const response = await scrape(
        { url: "https://firecrawl.dev", location: { country: "US" } },
        identity,
      );

      expect(response.markdown).toBeDefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses a scrape located outside the US",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://firecrawl.dev",
          location: { country: "NL" },
          timeout: scrapeTimeout,
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
      expect(response.body.error).toContain(
        'location.country "NL" isn\'t available to teams restricted to US-only processing',
      );
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses a crawl located outside the US",
    async () => {
      const response = await crawlStart(
        {
          url: "https://firecrawl.dev",
          scrapeOptions: { location: { country: "NL" } },
        },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses a map located outside the US",
    async () => {
      const response = await map(
        { url: "https://firecrawl.dev", location: { country: "NL" } },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "refuses a browser session located outside the US",
    async () => {
      const response = await browserCreateRaw(
        { location: { country: "NL" } },
        identity,
      );

      expect(response.statusCode).toBe(403);
      expect(response.body.code).toBe("US_ONLY_UNAVAILABLE");
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
