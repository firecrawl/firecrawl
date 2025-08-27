import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";

describe("V2 Scrape Screenshot Viewport", () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED) {
    let identity: Identity;

    beforeAll(async () => {
      identity = await idmux({
        name: "v2-scrape-viewport",
        concurrency: 100,
        credits: 1000000,
      });
    }, 10000);

    test("should take screenshot with custom viewport dimensions", async () => {
      const data = await scrape({
        url: "https://example.com",
        formats: [
          "markdown",
          {
            type: "screenshot",
            viewport: {
              width: 1920,
              height: 1080
            }
          }
        ],
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(data.markdown).toBeDefined();
    }, scrapeTimeout);

    test("should take full page screenshot with custom viewport width", async () => {
      const data = await scrape({
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            fullPage: true,
            viewport: {
              width: 1440,
              height: 900
            }
          }
        ],
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
    }, scrapeTimeout);

    test("should work with screenshot format without viewport (backwards compatibility)", async () => {
      const data = await scrape({
        url: "https://example.com",
        formats: ["screenshot"],
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
    }, scrapeTimeout);

    test("should work with object screenshot format without viewport", async () => {
      const data = await scrape({
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            fullPage: false
          }
        ],
      }, identity);

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
    }, scrapeTimeout);

    test("should reject invalid viewport dimensions", async () => {
      const response = await scrapeRaw({
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            viewport: {
              width: -100,
              height: 0
            }
          }
        ],
      }, identity);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    }, scrapeTimeout);

    test("should reject non-integer viewport dimensions", async () => {
      const response = await scrapeRaw({
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            viewport: {
              width: "1920" as any,
              height: 1080.5 as any
            }
          }
        ],
      }, identity);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    }, scrapeTimeout);

    test("should reject viewport dimensions exceeding maximum limits", async () => {
      const response = await scrapeRaw({
        url: "https://example.com",
        formats: [
          {
            type: "screenshot",
            viewport: {
              width: 8000, // exceeds max of 7680
              height: 5000 // exceeds max of 4320
            }
          }
        ],
      }, identity);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    }, scrapeTimeout);
  } else {
    it("mocked", () => {
      expect(true).toBe(true);
    });
  }
});