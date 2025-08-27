import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v1-json-extract-format",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describe("V1 JSON/Extract Format Backward Compatibility", () => {
  if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
    describe("extract format", () => {
    it.concurrent("should return extracted data in 'extract' field when using format='extract'", async () => {
      const response = await scrape({
        url: "https://jsonplaceholder.typicode.com/posts/1",
        formats: ["extract"],
        extract: {
          schema: {
            type: "object",
            properties: {
              userId: { type: "number" },
              id: { type: "number" },
              title: { type: "string" },
              body: { type: "string" }
            },
            required: ["userId", "id", "title", "body"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Data should be in extract field, not json field
      expect(response.extract).toBeDefined();
      expect(response.json).toBeUndefined();
      expect(response.extract.userId).toBe(1);
      expect(response.extract.id).toBe(1);
      expect(response.extract.title).toBeDefined();
      expect(response.extract.body).toBeDefined();
    }, scrapeTimeout);

    it.concurrent("should work with extract format and custom prompt", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["extract"],
        extract: {
          prompt: "Extract the main heading from the page",
          schema: {
            type: "object", 
            properties: {
              mainHeading: { type: "string" }
            },
            required: ["mainHeading"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Data should be in extract field, not json field
      expect(response.extract).toBeDefined();
      expect(response.json).toBeUndefined();
      expect(response.extract.mainHeading).toBeDefined();
    }, scrapeTimeout);
  });

  describe("json format", () => {
    it.concurrent("should return extracted data in 'json' field when using format='json'", async () => {
      const response = await scrape({
        url: "https://jsonplaceholder.typicode.com/posts/1",
        formats: ["json"],
        jsonOptions: {
          schema: {
            type: "object",
            properties: {
              userId: { type: "number" },
              id: { type: "number" },
              title: { type: "string" },
              body: { type: "string" }
            },
            required: ["userId", "id", "title", "body"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Data should be in json field, not extract field
      expect(response.json).toBeDefined();
      expect(response.extract).toBeUndefined();
      expect(response.json.userId).toBe(1);
      expect(response.json.id).toBe(1);
      expect(response.json.title).toBeDefined();
      expect(response.json.body).toBeDefined();
    }, scrapeTimeout);

    it.concurrent("should work with json format and custom prompt", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["json"],
        jsonOptions: {
          prompt: "Extract the main heading from the page",
          schema: {
            type: "object",
            properties: {
              mainHeading: { type: "string" }
            },
            required: ["mainHeading"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Data should be in json field, not extract field
      expect(response.json).toBeDefined();
      expect(response.extract).toBeUndefined();
      expect(response.json.mainHeading).toBeDefined();
    }, scrapeTimeout);
  });

  describe("multiple formats", () => {
    it.concurrent("should return markdown and extracted data in correct fields", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev",
        formats: ["markdown", "extract"],
        extract: {
          schema: {
            type: "object",
            properties: {
              mainHeading: { type: "string" },
              hasLinks: { type: "boolean" }
            },
            required: ["mainHeading", "hasLinks"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Both markdown and extract should be present
      expect(response.markdown).toBeDefined();
      expect(response.extract).toBeDefined();
      expect(response.json).toBeUndefined();
      expect(response.extract.mainHeading).toBeDefined();
      expect(typeof response.extract.hasLinks).toBe("boolean");
    }, scrapeTimeout);

    it.concurrent("should return markdown and json data in correct fields", async () => {
      const response = await scrape({
        url: "https://firecrawl.dev", 
        formats: ["markdown", "json"],
        jsonOptions: {
          schema: {
            type: "object",
            properties: {
              mainHeading: { type: "string" },
              hasLinks: { type: "boolean" }
            },
            required: ["mainHeading", "hasLinks"]
          }
        },
        timeout: scrapeTimeout,
      }, identity);

      // Both markdown and json should be present
      expect(response.markdown).toBeDefined();
      expect(response.json).toBeDefined();
      expect(response.extract).toBeUndefined();
      expect(response.json.mainHeading).toBeDefined();
      expect(typeof response.json.hasLinks).toBe("boolean");
    }, scrapeTimeout);
  });
  } else {
    it("should skip LLM tests in self-hosted mode without LLM keys", () => {
      expect(true).toBe(true);
    });
  }
});