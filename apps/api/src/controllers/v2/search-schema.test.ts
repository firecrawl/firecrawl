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
    expect(request.toolDetail).toBe("compact");
    expect(
      scrapeRequestSchema.parse({ url: "https://example.com" }).toolDetail,
    ).toBeUndefined();
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

  it("accepts optional agent task context without changing search defaults", () => {
    const request = searchRequestSchema.parse({
      query: "React memo docs",
      objective:
        "  Find official guidance on preventing unnecessary rerenders  ",
      clientModel: "  claude-sonnet-4-6  ",
    });

    expect(request).toMatchObject({
      query: "React memo docs",
      objective: "Find official guidance on preventing unnecessary rerenders",
      clientModel: "claude-sonnet-4-6",
      limit: 10,
    });
    expect(
      searchRequestSchema.parse({ query: "React memo docs" }),
    ).not.toHaveProperty("objective");
  });

  it.each([
    { objective: " " },
    { objective: "x".repeat(5001) },
    { objective: null },
    { clientModel: " " },
    { clientModel: "x".repeat(129) },
    { clientModel: 42 },
  ])("drops invalid agent task context without failing the search %j", context => {
    const result = searchRequestSchema.safeParse({
      query: "React memo docs",
      ...context,
    });

    expect(result.success).toBe(true);
    expect(result.data?.objective).toBeUndefined();
    expect(result.data?.clientModel).toBeUndefined();
    expect(result.data?.limit).toBe(10);
  });
});
