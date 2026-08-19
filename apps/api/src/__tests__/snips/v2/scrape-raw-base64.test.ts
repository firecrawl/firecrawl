import { describeIf, TEST_PRODUCTION } from "../lib";
import {
  scrape,
  scrapeRaw,
  scrapeTimeout,
  crawl,
  idmux,
  Identity,
} from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-raw-base64",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

// A stable, Firecrawl-controlled image asset served with an image/* content-type.
const IMAGE_URL = "https://firecrawl-test-site.vercel.app/declared-logo.png";
// A regular HTML page on the same test site.
const HTML_URL = "https://firecrawl-test-site.vercel.app/";

// Fetching a real image URL depends on production scraping engines.
describeIf(TEST_PRODUCTION)("Scrape rawBase64 format", () => {
  it.concurrent(
    "returns image bytes as a base64 data URI",
    async () => {
      const response = await scrape(
        {
          url: IMAGE_URL,
          formats: ["rawBase64"],
        },
        identity,
      );

      expect(response.rawBase64).toBeDefined();
      expect(typeof response.rawBase64).toBe("string");
      expect(response.rawBase64!.startsWith("data:image/")).toBe(true);
      expect(response.rawBase64).toContain(";base64,");

      // The payload after the comma must decode to non-empty bytes.
      const b64 = response.rawBase64!.split(",")[1];
      expect(b64.length).toBeGreaterThan(0);
      const buffer = Buffer.from(b64, "base64");
      expect(buffer.length).toBeGreaterThan(0);

      expect(response.metadata?.contentType?.startsWith("image/")).toBe(true);
    },
    scrapeTimeout,
  );

  it.concurrent(
    "errors on an image URL without the format, hinting at rawBase64",
    async () => {
      const raw = await scrapeRaw(
        {
          url: IMAGE_URL,
        },
        identity,
      );

      expect(raw.statusCode).not.toBe(200);
      expect(raw.body.success).toBe(false);
      expect(raw.body.code).toBe("SCRAPE_UNSUPPORTED_FILE_ERROR");
      expect(raw.body.error).toContain("rawBase64");
    },
    scrapeTimeout,
  );

  it.concurrent(
    "omits rawBase64 (no error) when the URL is not an image",
    async () => {
      const response = await scrape(
        {
          url: HTML_URL,
          formats: ["markdown", "rawBase64"],
        },
        identity,
      );

      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
      expect(response.rawBase64).toBeUndefined();
    },
    scrapeTimeout,
  );

  it.concurrent(
    "returns base64 for images when rawBase64 is in crawl scrapeOptions",
    async () => {
      const response = await crawl(
        {
          url: IMAGE_URL,
          limit: 1,
          scrapeOptions: {
            formats: ["rawBase64"],
          },
        },
        identity,
      );

      expect(response.status).toBe("completed");
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data.length).toBeGreaterThan(0);

      const doc = response.data[0];
      expect(doc.rawBase64).toBeDefined();
      expect(doc.rawBase64!.startsWith("data:image/")).toBe(true);
    },
    scrapeTimeout * 2,
  );
});
