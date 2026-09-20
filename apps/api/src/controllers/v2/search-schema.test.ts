import { describe, expect, it } from "vitest";
import { searchRequestSchema, scrapeRequestSchema } from "./types";

describe("searchRequestSchema highlights", () => {
  it.each(["compact", "summary", "full"])(
    "accepts %s tool detail",
    toolDetail => {
      expect(
        searchRequestSchema.parse({ query: "records", toolDetail }).toolDetail,
      ).toBe(toolDetail);
      expect(
        scrapeRequestSchema.parse({
          url: "https://example.com",
          domainTools: true,
          toolDetail,
        }).toolDetail,
      ).toBe(toolDetail);
    },
  );
  it("rejects unknown tool detail", () => {
    expect(
      searchRequestSchema.safeParse({ query: "records", toolDetail: "all" })
        .success,
    ).toBe(false);
  });
  it("preserves an omitted value for integration and rollout selection", () => {
    const request = searchRequestSchema.parse({ query: "firecrawl" });

    expect(request.highlights).toBeUndefined();
  });

  it("allows highlights to be enabled explicitly", () => {
    const request = searchRequestSchema.parse({
      query: "firecrawl",
      highlights: true,
    });

    expect(request.highlights).toBe(true);
  });

  it("allows highlights to be disabled explicitly", () => {
    const request = searchRequestSchema.parse({
      query: "firecrawl",
      highlights: false,
    });

    expect(request.highlights).toBe(false);
  });
});
