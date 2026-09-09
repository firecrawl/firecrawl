import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

function httpMock() {
  return {
    post: jest.fn(async () => ({ status: 200, data: { success: true } })),
  } as any;
}

describe("v2 search country", () => {
  test("forwards the country option", async () => {
    const http = httpMock();

    await search(http, { query: "firecrawl", country: "de" });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "firecrawl", country: "de" },
      {},
    );
  });

  test("omits country when the caller does not set it", async () => {
    const http = httpMock();

    await search(http, { query: "firecrawl" });

    expect(http.post).toHaveBeenCalledWith("/v2/search", { query: "firecrawl" }, {});
    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("country");
  });
});
