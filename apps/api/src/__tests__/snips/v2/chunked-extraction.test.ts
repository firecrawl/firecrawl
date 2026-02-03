import { describeIf, HAS_AI, TEST_PRODUCTION } from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "chunked-extraction",
    concurrency: 10,
    credits: 100000,
  });
}, 10000 + scrapeTimeout);

describeIf(HAS_AI)("Chunked LLM Extraction", () => {
  // Test that extraction works with array schemas
  it(
    "extracts array data with json format",
    async () => {
      const response = await scrape(
        {
          url: "https://news.ycombinator.com",
          formats: [
            {
              type: "json",
              prompt: "Extract the top stories from the page",
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string", description: "The story title" },
                    points: {
                      type: "number",
                      description: "The number of points",
                    },
                    author: {
                      type: "string",
                      description: "The username of the author",
                    },
                  },
                },
              },
            },
          ],
        },
        identity,
      );

      expect(response.json).toBeDefined();
      expect(Array.isArray(response.json)).toBe(true);
      expect(response.json.length).toBeGreaterThan(0);

      // Verify structure of first item
      const firstItem = response.json[0];
      expect(firstItem).toHaveProperty("title");
      expect(typeof firstItem.title).toBe("string");
    },
    scrapeTimeout * 2,
  );

  // Test object extraction
  it(
    "extracts object data with json format",
    async () => {
      const response = await scrape(
        {
          url: "https://example.com",
          formats: [
            {
              type: "json",
              prompt: "Extract the main content of this page",
              schema: {
                type: "object",
                properties: {
                  title: { type: "string", description: "The page title" },
                  description: {
                    type: "string",
                    description: "Main description or content",
                  },
                  hasLinks: {
                    type: "boolean",
                    description: "Whether the page has links",
                  },
                },
              },
            },
          ],
        },
        identity,
      );

      expect(response.json).toBeDefined();
      expect(typeof response.json).toBe("object");
      expect(response.json).toHaveProperty("title");
    },
    scrapeTimeout,
  );
});
