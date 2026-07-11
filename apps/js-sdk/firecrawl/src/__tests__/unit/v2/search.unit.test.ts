import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

function makeHttp() {
  return {
    post: jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, data: { web: [] } },
    }),
  };
}

describe("v2.search unit", () => {
  test("serializes highlights when set to false", async () => {
    const http = makeHttp();

    await search(http as any, { query: "firecrawl", highlights: false });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl", highlights: false },
      {},
    );
  });

  test("serializes highlights when set to true", async () => {
    const http = makeHttp();

    await search(http as any, { query: "firecrawl", highlights: true });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl", highlights: true },
      {},
    );
  });

  test("omits highlights from payload when not set", async () => {
    const http = makeHttp();

    await search(http as any, { query: "firecrawl" });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl" },
      {},
    );
    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect("highlights" in payload).toBe(false);
  });
});
