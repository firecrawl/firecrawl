import { scrape, scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "parsers",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("Parsers parameter tests", () => {
  const pdfUrl = "https://www.orimi.com/pdf-test.pdf";
  const htmlUrl = "https://firecrawl.dev";

  describe("Array format", () => {
    it.concurrent("accepts parsers: ['pdf'] and parses PDF", async () => {
      const response = await scrape({
        url: pdfUrl,
        parsers: ["pdf"],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("PDF Test File");
      expect(response.metadata.numPages).toBeGreaterThan(0);
    }, scrapeTimeout * 2);

    it.concurrent("accepts parsers: [] and returns PDF in base64", async () => {
      const response = await scrape({
        url: pdfUrl,
        parsers: [],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("JVBER"); // base64
    }, scrapeTimeout * 2);

    it.concurrent("accepts parsers: ['pdf'] on HTML pages (no effect)", async () => {
      const response = await scrape({
        url: htmlUrl,
        parsers: ["pdf"],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("Firecrawl");
    }, scrapeTimeout);

    it.concurrent("accepts empty parsers array on HTML pages", async () => {
      const response = await scrape({
        url: htmlUrl,
        parsers: [],
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("Firecrawl");
    }, scrapeTimeout);
  });


  describe("Default behavior", () => {
    it.concurrent("parses PDF by default when parsers not specified", async () => {
      const response = await scrape({
        url: pdfUrl,
      }, identity);

      expect(response.markdown).toBeDefined();
      expect(response.markdown).toContain("PDF Test File");
      expect(response.metadata.numPages).toBeGreaterThan(0);
    }, scrapeTimeout * 2);
  });

  describe("Invalid inputs", () => {
    it.concurrent("rejects invalid parser types", async () => {
      const raw = await scrapeRaw({
        url: pdfUrl,
        parsers: ["invalid-parser" as any],
      }, identity);

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.error).toBe("Bad Request");
    }, scrapeTimeout);

    it.concurrent("rejects non-array parsers", async () => {
      const raw = await scrapeRaw({
        url: pdfUrl,
        parsers: "pdf" as any,
      }, identity);

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.error).toBe("Bad Request");
    }, scrapeTimeout);

    it.concurrent("rejects old object format", async () => {
      const raw = await scrapeRaw({
        url: pdfUrl,
        parsers: { pdf: true } as any,
      }, identity);

      expect(raw.statusCode).toBe(400);
      expect(raw.body.success).toBe(false);
      expect(raw.body.error).toBe("Bad Request");
    }, scrapeTimeout);
  });

  describe("Billing implications", () => {
    it.concurrent("bills correctly with parsers: ['pdf']", async () => {
      const response = await scrape({
        url: pdfUrl,
        parsers: ["pdf"],
      }, identity);

      // Should bill based on number of pages when PDF parsing is enabled
      expect(response.metadata.creditsUsed).toBeGreaterThanOrEqual(response.metadata.numPages || 1);
    }, scrapeTimeout * 2);

    it.concurrent("bills flat rate with parsers: []", async () => {
      const response = await scrape({
        url: pdfUrl,
        parsers: [],
      }, identity);

      // Should bill flat rate (1 credit) when PDF parsing is disabled
      expect(response.metadata.creditsUsed).toBe(1);
    }, scrapeTimeout * 2);
  });
});