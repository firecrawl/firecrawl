import { describe, expect, jest, test } from "@jest/globals";
import { search } from "../../../v2/methods/search";

describe("v2 search country", () => {
  test("forwards the country option to /v2/search", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, data: { web: [] } },
      })),
    } as any;

    await search(http, { query: "restaurants", country: "DE", limit: 5 });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "restaurants", country: "DE", limit: 5 },
      {},
    );
  });

  test("omits country when undefined", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, data: { web: [] } },
      })),
    } as any;

    await search(http, { query: "firecrawl" });

    const payload = http.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toEqual({ query: "firecrawl" });
    expect(payload).not.toHaveProperty("country");
  });

  test("forwards country alongside enterprise", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, data: { web: [] } },
      })),
    } as any;

    await search(http, {
      query: "sensitive topic",
      country: "US",
      enterprise: ["zdr"],
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      {
        query: "sensitive topic",
        country: "US",
        enterprise: ["zdr"],
      },
      {},
    );
  });
});
