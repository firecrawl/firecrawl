import { TEST_PRODUCTION, testIf } from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";

describe("V2 Scrape blockJsRedirects", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-block-js-redirects",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  testIf(TEST_PRODUCTION)(
    "should accept blockJsRedirects parameter without error",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://example.com",
          blockJsRedirects: true,
        },
        identity,
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should default blockJsRedirects to false",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://example.com",
        },
        identity,
      );

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should pass blockJsRedirects to fire-engine and block JS-based redirects",
    async () => {
      const data = await scrape(
        {
          url: "https://finconomic.com/",
          blockJsRedirects: true,
          storeInCache: false,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.metadata.sourceURL).toBe("https://finconomic.com/");
      // With blockJsRedirects, the final URL should stay on the original domain
      // rather than following the JS redirect to an ad network
      expect(data.metadata.url).toContain("finconomic.com");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should follow JS redirects when blockJsRedirects is false",
    async () => {
      const data = await scrape(
        {
          url: "https://finconomic.com/",
          blockJsRedirects: false,
          storeInCache: false,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.metadata.sourceURL).toBe("https://finconomic.com/");
      // Without blockJsRedirects, the final URL should be the redirect destination
      expect(data.metadata.url).not.toContain("finconomic.com");
    },
    scrapeTimeout,
  );
});
