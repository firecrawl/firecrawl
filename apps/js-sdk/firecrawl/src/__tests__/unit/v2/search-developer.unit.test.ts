import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

const developerResult = {
  title: "https://github.com/firecrawl/firecrawl/issues/1",
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

  test("returns developer results", async () => {
    const http = httpWith({
      web: [{ title: "W", url: "http://a.com" }],
      developer: [developerResult],
    });

    const result = await search(http, {
      query: "firecrawl",
      categories: [{ type: "developer" }],
    });

    expect(result.web).toHaveLength(1);
    expect(result.developer).toHaveLength(1);
    expect(result.developer?.[0]).toEqual(developerResult);
  });

  test("omits developer when the response has none", async () => {
    const http = httpWith({ web: [] });

    const result = await search(http, { query: "firecrawl" });

    expect(result.developer).toBeUndefined();
  });

  test("lists developer in the .data error", async () => {
    const http = httpWith({ developer: [developerResult] });

    const result = await search(http, {
      query: "firecrawl",
      categories: ["developer"],
    });

    expect(() => (result as any).data).toThrow(/\.developer \(1 results\)/);
  });
});
