import {
  ALLOW_TEST_SUITE_WEBSITE,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  testIf,
} from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";

describe("V2 Scrape skipTlsVerification Default", () => {
  let identity: Identity;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-skip-tls",
      concurrency: 100,
      credits: 1000000,
    });
  }, 10000);

  test(
    "should default skipTlsVerification to true in v2 API",
    async () => {
      const data = await scrape(
        {
          url: "https://expired.badssl.com/",
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain("badssl.com");
    },
    scrapeTimeout,
  );

  test(
    "should allow explicit skipTlsVerification: false override",
    async () => {
      const response = await scrapeRaw(
        {
          url: "https://expired.badssl.com/",
          skipTlsVerification: false,
          maxAge: 0,
        },
        identity,
      );

      if (response.status !== 422) {
        console.warn("Non-422 response:", JSON.stringify(response.body));
      }

      expect(response.status).toBe(422);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  testIf(ALLOW_TEST_SUITE_WEBSITE)(
    "should work with valid HTTPS sites regardless of skipTlsVerification setting",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE, // NOTE: test website in self-host mode may not use TLS, need to check this out
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: false }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format with fullPage",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: true }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );
});
