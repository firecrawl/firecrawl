import {
  describeIf,
  concurrentIf,
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { Identity, idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";

describeIf(ALLOW_TEST_SUITE_WEBSITE)("V2 Scrape html-extractor", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-html-extractor",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "returns markdown via html-extractor when __experimental_htmlExtractor is set",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          __experimental_htmlExtractor: true,
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
      expect(response.markdown!.length).toBeGreaterThan(0);
      expect(response.markdown).toContain("Firecrawl");

      // Live path attaches these fields from the extractor result.
      expect(typeof response.extractionQuality).toBe("number");
      expect(typeof response.pageType).toBe("string");
    },
    scrapeTimeout,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "does not run html-extractor when flag is omitted",
    async () => {
      const response = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("Firecrawl");
      expect(response.extractionQuality).toBeUndefined();
      expect(response.pageType).toBeUndefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "rejects __experimental_htmlExtractor with a non-boolean value",
    async () => {
      const raw = await scrapeRaw(
        {
          url: TEST_SUITE_WEBSITE,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          __experimental_htmlExtractor: "yes" as any,
        },
        identity,
      );

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    },
    scrapeTimeout,
  );
});
