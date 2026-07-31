import { describe, expect, it } from "vitest";
import { searchRequestSchema } from "./types";

describe("searchRequestSchema highlights", () => {
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
