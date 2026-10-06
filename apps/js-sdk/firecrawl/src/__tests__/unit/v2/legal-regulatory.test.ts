import { describe, expect, jest, test } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";
import { search } from "../../../v2/methods/search";
import { SdkError } from "../../../v2/types";

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

describe("legalRegulatorySearch", () => {
  test.each([
    [{ k: 5 }, { query: "food labeling requirements", k: 5 }],
    [undefined, { query: "food labeling requirements" }],
  ])("posts %p and returns web results", async (options, body) => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: response })),
    } as any;

    const result = await clientWith(http).legalRegulatorySearch(
      "food labeling requirements",
      options,
    );

    expect(http.post).toHaveBeenCalledWith("/v2/search/gov", body);
    expect(result).toEqual(response);
  });

  test("rejects an empty query", async () => {
    const http = { post: jest.fn() } as any;

    await expect(
      clientWith(http).legalRegulatorySearch("  "),
    ).rejects.toThrow("query cannot be empty");
    expect(http.post).not.toHaveBeenCalled();
  });

  test("throws on an unsuccessful response body", async () => {
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: false, error: "Search failed" },
      })),
    } as any;

    await expect(
      clientWith(http).legalRegulatorySearch("zoning variance"),
    ).rejects.toThrow("Search failed");
  });

  test("normalizes transport errors to SdkError", async () => {
    const http = {
      post: jest.fn(async () => {
        throw {
          isAxiosError: true,
          code: "ECONNABORTED",
          message: "request timed out",
        };
      }),
    } as any;

    await expect(
      clientWith(http).legalRegulatorySearch("network failure"),
    ).rejects.toBeInstanceOf(SdkError);
  });
});

describe("search gov category", () => {
  test("forwards the gov category and returns results inside web", async () => {
    const web = [{ ...response.data.web[0], category: "gov" }];
    const http = {
      post: jest.fn(async () => ({
        status: 200,
        data: { success: true, data: { web } },
      })),
    } as any;

    const result = await search(http, {
      query: "zoning variance",
      categories: [{ type: "gov" }],
    });

    expect(http.post).toHaveBeenCalledWith(
      "/v2/search",
      { query: "zoning variance", categories: [{ type: "gov" }] },
      {},
    );
    expect(result.web).toEqual(web);
  });
});
