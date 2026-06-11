import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  HAS_AI,
  HAS_FIREWORKS,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
} from "../lib";
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
  concurrentIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "returns a non-empty answer for a valid query",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
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

  concurrentIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "returns a non-empty answer for a valid question",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "question", question: "What is Firecrawl?" }],
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

  concurrentIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "returns both answer and markdown when formats include markdown and query",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
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

  concurrentIf(TEST_PRODUCTION || (HAS_FIREWORKS && ALLOW_TEST_SUITE_WEBSITE))(
    "returns non-empty highlights for a valid highlights query",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "highlights", query: "What is Firecrawl?" }],
        },
        identity,
      );

      expect(response.highlights).toBeDefined();
      expect(typeof response.highlights).toBe("string");
      expect(response.highlights!.length).toBeGreaterThan(0);
      expect(response.answer).toBeUndefined();
    },
    scrapeTimeout,
  );

  concurrentIf(TEST_PRODUCTION || (HAS_FIREWORKS && ALLOW_TEST_SUITE_WEBSITE))(
    "returns a direct quote answer when query mode is directQuote",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
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

  concurrentIf(TEST_PRODUCTION || (HAS_AI && ALLOW_TEST_SUITE_WEBSITE))(
    "does not include answer field when query format is not provided",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
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
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "query", prompt: longPrompt }],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );

  it(
    "rejects question over 10000 characters",
    async () => {
      const response = await scrapeWithFailure(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "question", question: "a".repeat(10001) }],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );

  it(
    "rejects highlights query over 10000 characters",
    async () => {
      const response = await scrapeWithFailure(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "highlights", query: "a".repeat(10001) }],
        } as any,
        identity,
      );

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
    },
    scrapeTimeout,
  );
});
