import { describe, expect, jest, test } from "@jest/globals";
import { FirecrawlClient } from "../../../v2/client";
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
  test("posts query and k and returns web results", async () => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: response })),
    } as any;

    const result = await clientWith(http).legalRegulatorySearch(
      "food labeling requirements",
      { k: 5 },
    );

    expect(http.post).toHaveBeenCalledWith("/v2/search/legal-regulatory", {
      query: "food labeling requirements",
      k: 5,
    });
    expect(result).toEqual(response);
  });

  test("omits k when not provided", async () => {
    const http = {
      post: jest.fn(async () => ({ status: 200, data: response })),
    } as any;

    await clientWith(http).legalRegulatorySearch("zoning variance");

    expect(http.post).toHaveBeenCalledWith("/v2/search/legal-regulatory", {
      query: "zoning variance",
    });
  });

  test("rejects an empty query", async () => {
    const http = { post: jest.fn() } as any;

    await expect(
      clientWith(http).legalRegulatorySearch("  "),
    ).rejects.toThrow("query cannot be empty");
    expect(http.post).not.toHaveBeenCalled();
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
