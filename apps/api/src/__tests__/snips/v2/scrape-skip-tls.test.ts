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

  test("should default skipTlsVerification to true in v2 API", async () => {
    const data = await scrape({
      url: "https://expired.badssl.com/",
      maxAge: 0,
    }, identity);

    expect(data).toBeDefined();
    expect(data.markdown).toContain("badssl.com");
  }, scrapeTimeout);

  test("should allow explicit skipTlsVerification: false override", async () => {
    const response = await scrapeRaw({
      url: "https://expired.badssl.com/",
      skipTlsVerification: false,
      maxAge: 0,
    }, identity);

    if (response.status !== 500) {
      console.warn('Non-500 response:', JSON.stringify(response.body));
    }

    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
  }, scrapeTimeout);

  test("should work with valid HTTPS sites regardless of skipTlsVerification setting", async () => {
    const data = await scrape({
      url: "https://firecrawl.dev",
      maxAge: 0,
    }, identity);

    expect(data).toBeDefined();
    expect(data.markdown).toContain("Firecrawl");
  }, scrapeTimeout);

  if (!process.env.TEST_SUITE_SELF_HOSTED) {
    test("should support object screenshot format", async () => {
      const data = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "screenshot", fullPage: false }],
        maxAge: 0,
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    }, scrapeTimeout);

    test("should support object screenshot format with fullPage", async () => {
      const data = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "screenshot", fullPage: true }],
        maxAge: 0,
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    }, scrapeTimeout);
  }
});
