import { describeIf, itIf, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  idmux,
  Identity,
  crawlStart,
  extractRaw,
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

  itIf(!HAS_US_OPENAI)(
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
