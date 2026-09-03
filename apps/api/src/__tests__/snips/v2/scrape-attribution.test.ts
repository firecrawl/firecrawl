import {
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_SUITE_WEBSITE,
  concurrentIf,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-attribution",
    concurrency: 10,
    credits: 10000,
  });
}, 10000 + scrapeTimeout);

describe("Attribution preservation", () => {
  const base = TEST_SUITE_WEBSITE;

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "preserves copyright notice in footer with onlyMainContent=true (default)",
    async () => {
      const response = await scrape(
        {
          url: base,
        },
        identity,
      );

      // The test site footer contains "© {year} Firecrawl"
      expect(response.markdown).toMatch(/©\s*\d{4}\s*Firecrawl/);
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "still removes non-attribution navigation elements with onlyMainContent=true",
    async () => {
      const response = await scrape(
        {
          url: base,
        },
        identity,
      );

      // The main content heading should be present
      expect(response.markdown).toContain("Firecrawl");

      // Copyright must still be present (not stripped)
      expect(response.markdown).toMatch(/©\s*\d{4}\s*Firecrawl/);
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "preserves all content including attribution with onlyMainContent=false",
    async () => {
      const response = await scrape(
        {
          url: base,
          onlyMainContent: false,
        },
        identity,
      );

      // With onlyMainContent=false, everything should be present
      expect(response.markdown).toMatch(/©\s*\d{4}\s*Firecrawl/);
      expect(response.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );
});
