import {
  scrapeRequestSchema,
  searchRequestSchema,
  crawlRequestSchema,
} from "./types";

describe("knowledgeGraph request format", () => {
  it("accepts the shorthand for scraping and rejects oversized entity allow-lists", () => {
    const valid = scrapeRequestSchema.safeParse({
      url: "https://example.com",
      formats: ["knowledgeGraph"],
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.formats).toContainEqual({ type: "knowledgeGraph" });
    }

    expect(
      scrapeRequestSchema.safeParse({
        url: "https://example.com",
        formats: [
          {
            type: "knowledgeGraph",
            entityTypes: Array.from({ length: 51 }, (_, i) => `Type${i}`),
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts knowledgeGraph through search scrapeOptions", () => {
    const parsed = searchRequestSchema.safeParse({
      query: "Ada Lovelace",
      scrapeOptions: {
        formats: [{ type: "knowledgeGraph", entityTypes: ["Person"] }],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scrapeOptions?.formats).toContainEqual({
        type: "knowledgeGraph",
        entityTypes: ["Person"],
      });
    }
  });

  it("accepts knowledgeGraph through crawl scrapeOptions", () => {
    const parsed = crawlRequestSchema.safeParse({
      url: "https://example.com",
      scrapeOptions: { formats: ["knowledgeGraph"] },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scrapeOptions?.formats).toContainEqual({
        type: "knowledgeGraph",
      });
    }
  });
});
