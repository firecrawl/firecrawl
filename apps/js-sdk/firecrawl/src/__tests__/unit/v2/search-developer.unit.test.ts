import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";
import type { SearchResultWeb } from "../../../v2/types";

// Developer results arrive in the exact web schema.
const developerResult: SearchResultWeb = {
  title: "Retry requests",
  url: "https://github.com/firecrawl/firecrawl/issues/1",
  description: "passage",
  position: 1,
  category: "developer",
};

function httpWith(data: Record<string, unknown>) {
  return {
    post: jest.fn(async () => ({ status: 200, data: { success: true, data } })),
  } as any;
}

describe("v2 search developer category", () => {
  test("forwards the developer category", async () => {
    const http = httpWith({});

    await search(http, { query: "firecrawl", categories: ["developer"] });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl", categories: ["developer"] },
      {},
    );
  });

  test("returns developer results inside web", async () => {
    const http = httpWith({ web: [developerResult] });

    const result = await search(http, {
      query: "firecrawl",
      categories: [{ type: "developer" }],
    });

    expect(result.web).toEqual([developerResult]);
    expect(result).not.toHaveProperty("developer");
  });

  test("lists developer results as web results in the .data error", async () => {
    const http = httpWith({ web: [developerResult] });

    const result = await search(http, {
      query: "firecrawl",
      categories: ["developer"],
    });

    expect(() => (result as any).data).toThrow(/\.web \(1 results\)/);
  });
});
