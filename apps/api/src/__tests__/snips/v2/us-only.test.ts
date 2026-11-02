import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeWithFailure,
  scrapeTimeout,
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
      const response = await scrapeWithFailure(
        { url: "https://x.com/NASA", timeout: scrapeTimeout },
        identity,
      );

      expect(response.error).toContain(
        "X/Twitter scraping is not available for teams restricted to US-only processing.",
      );
    },
    scrapeTimeout,
  );
});
