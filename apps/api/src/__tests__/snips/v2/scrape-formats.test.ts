import { scrape, scrapeWithFailure, scrapeTimeout, idmux, Identity, scrapeRaw } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-formats",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Scrape format variations", () => {
  describe("String format inputs", () => {
    it.concurrent("accepts string format for markdown", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "markdown" }],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
      expect(response.markdown?.length).toBeGreaterThan(0);
    }, scrapeTimeout);

    it.concurrent("accepts multiple string formats", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", "html", "links"],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.html).toBeDefined();
      expect(response.links).toBeDefined();
      expect(Array.isArray(response.links)).toBe(true);
    }, scrapeTimeout);

    it.concurrent("accepts string format for screenshot", async () => {
      if (process.env.TEST_SUITE_SELF_HOSTED) {
        return;
      }

      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["screenshot"],
      }, identity);

      expect(response.screenshot).toBeDefined();
      expect(typeof response.screenshot).toBe("string");
    }, scrapeTimeout);
  });

  describe("Object format inputs", () => {
    it.concurrent("accepts object format for markdown", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "markdown" }],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
      expect(response.markdown?.length).toBeGreaterThan(0);
    }, scrapeTimeout);

    it.concurrent("accepts multiple object formats", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [
          { type: "markdown" },
          { type: "html" },
          { type: "links" }
        ],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.html).toBeDefined();
      expect(response.links).toBeDefined();
      expect(Array.isArray(response.links)).toBe(true);
    }, scrapeTimeout);

    it.concurrent("accepts object format for screenshot with options", async () => {
      if (process.env.TEST_SUITE_SELF_HOSTED) {
        return;
      }

      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [{
          type: "screenshot",
          fullPage: true,
          quality: 80,
          viewport: { width: 1920, height: 1080 }
        }],
      }, identity);

      expect(response.screenshot).toBeDefined();
      expect(typeof response.screenshot).toBe("string");
    }, scrapeTimeout);
  });

  describe("Mixed format inputs", () => {
    it.concurrent("accepts mixed string and object formats", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [
          "markdown",
          { type: "html" },
          "links"
        ],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.html).toBeDefined();
      expect(response.links).toBeDefined();
    }, scrapeTimeout);

    it.concurrent("handles complex formats alongside simple ones", async () => {
      if (!process.env.TEST_SUITE_SELF_HOSTED) {
        const response = await scrape({
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            {
              type: "screenshot",
              fullPage: false,
              quality: 90
            },
            { type: "links" }
          ],
        }, identity);

        expect(response.markdown).toBeDefined();
        expect(response.screenshot).toBeDefined();
        expect(response.links).toBeDefined();
      }
    }, scrapeTimeout);
  });

  describe("Format with options that already exist", () => {
    it.concurrent("handles json format with schema", async () => {
      if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
        const response = await scrape({
          url: "https://firecrawl.dev",
          formats: [{
            type: "json",
            prompt: "Extract the main heading and description",
            schema: {
              type: "object",
              properties: {
                heading: { type: "string" },
                description: { type: "string" }
              }
            }
          }],
        }, identity);

        expect(response.json).toBeDefined();
        expect(typeof response.json).toBe("object");
      }
    }, scrapeTimeout);

    it.concurrent("handles changeTracking format with options", async () => {
      if (!process.env.TEST_SUITE_SELF_HOSTED) {
        const response = await scrape({
          url: "https://firecrawl.dev",
          formats: [
            "markdown",
            {
              type: "changeTracking",
              modes: ["json"],
              tag: "test-tag"
            }
          ],
        }, identity);

        expect(response.markdown).toBeDefined();
        expect(response.changeTracking).toBeDefined();
      }
    }, scrapeTimeout);
  });

  describe("Edge cases and validation", () => {
    it.concurrent("default format is markdown when formats not specified", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(typeof response.markdown).toBe("string");
    }, scrapeTimeout);

    it.concurrent("rejects invalid format type in object", async () => {
      const raw = await scrapeRaw({
        url: "https://firecrawl.dev",
        formats: [{ type: "invalid-format" } as any],
      }, identity);

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
    }, scrapeTimeout);

    it.concurrent("maintains backward compatibility with string-only formats", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", "html", "rawHtml", "links"],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.html).toBeDefined();
      expect(response.rawHtml).toBeDefined();
      expect(response.links).toBeDefined();
    }, scrapeTimeout);
  });

  describe("Format type consistency in output", () => {
    it.concurrent("string input produces consistent output structure", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", "html"],
      }, identity);

      const keys = Object.keys(response);
      expect(keys).toContain("markdown");
      expect(keys).toContain("html");
      expect(keys).toContain("metadata");
    }, scrapeTimeout);

    it.concurrent("object input produces identical output structure", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "markdown" }, { type: "html" }],
      }, identity);

      const keys = Object.keys(response);
      expect(keys).toContain("markdown");
      expect(keys).toContain("html");
      expect(keys).toContain("metadata");
    }, scrapeTimeout);

    it.concurrent("mixed input produces consistent output", async () => {
      const response1 = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", "html"],
      }, identity);

      const response2 = await scrape({
        url: "https://firecrawl.dev",
        formats: [{ type: "markdown" }, { type: "html" }],
      }, identity);

      const response3 = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", { type: "html" }],
      }, identity);

      expect(Object.keys(response1).sort()).toEqual(Object.keys(response2).sort());
      expect(Object.keys(response2).sort()).toEqual(Object.keys(response3).sort());
    }, scrapeTimeout);
  });
});