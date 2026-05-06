import { concurrentIf, HAS_AI, HAS_FIREWORKS, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeWithFailure,
  scrapeTimeout,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-query",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Query format", () => {
  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns a non-empty answer for a valid query",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "query", prompt: "What is Firecrawl?" }],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.answer!.length).toBeGreaterThan(0);
      expect(response.markdown).toBeUndefined();
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "returns both answer and markdown when formats include markdown and query",
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

      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.answer!.length).toBeGreaterThan(0);
      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_FIREWORKS)(
    "returns a direct quote answer when query mode is directQuote",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: [
            {
              type: "query",
              prompt: "What is Firecrawl?",
              mode: "directQuote",
            },
          ],
        },
        identity,
      );

      expect(response.answer).toBeDefined();
      expect(typeof response.answer).toBe("string");
      expect(response.answer!.length).toBeGreaterThan(0);
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || HAS_AI)(
    "does not include answer field when query format is not provided",
    async () => {
      const response = await scrape(
        {
          url: "https://firecrawl.dev",
          formats: ["markdown"],
        },
        identity,
      );

      expect(response.answer).toBeUndefined();
    },
    scrapeTimeout,
  );

  it(
    "rejects query prompt over 10000 characters",
    async () => {
      const longPrompt = "a".repeat(10001);
      const response = await scrapeWithFailure(
        {
          url: "https://firecrawl.dev",
          formats: [{ type: "query", prompt: longPrompt }],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );
});
