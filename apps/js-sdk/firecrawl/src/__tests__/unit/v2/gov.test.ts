import { describe, expect, jest, test } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";

const response = {
  success: true,
  data: {
    web: [
      {
        url: "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101",
        title: "21 CFR Part 101 -- Food Labeling",
        description: "matched snippet",
        position: 1,
      },
    ],
  },
};

function clientWith(http: any) {
  const client = new FirecrawlClient({
    apiKey: "test",
    apiUrl: "http://localhost",
  });
  (client as any).http = http;
  return client;
}

describe("govSearch", () => {
  test.each([
    [{ k: 5 }, { query: "food labeling requirements", k: 5 }],
    [undefined, { query: "food labeling requirements" }],
  ])("posts %p and returns web results", async (options, body) => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: response })),
    } as any;

    const result = await clientWith(http).govSearch(
      "food labeling requirements",
      options,
    );

    expect(http.post).toHaveBeenCalledWith("/v2/search/gov", body);
    expect(result).toEqual(response);
  });

  test("rejects an empty query", async () => {
    const http = { post: jest.fn() } as any;

    await expect(clientWith(http).govSearch("  ")).rejects.toThrow(
      "query cannot be empty",
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  test("throws on an unsuccessful response body", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: false, error: "Search failed" },
      })),
    } as any;

    await expect(clientWith(http).govSearch("zoning variance")).rejects.toThrow(
      "Search failed",
    );
  });
});
