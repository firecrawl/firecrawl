import { describe, expect, vi, test } from "vitest";
import { search } from "../../../v2/methods/search";

describe("v2 search highlights", () => {
  test("forwards the highlights option", async () => {
    const http = {
      post: vi.fn(async () => ({ status: 200, data: { success: true } })),
    } as any;

    await search(http, { query: "firecrawl", highlights: false });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl", highlights: false },
      {},
    );
  });
});
