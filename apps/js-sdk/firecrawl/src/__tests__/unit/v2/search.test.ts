import { describe, test, expect, jest } from "@jest/globals";
import { search } from "../../../v2/methods/search";

describe("JS SDK v2 search creditsUsed", () => {
  function makeHttp(postImpl: (url: string, data: any) => any) {
    return { post: jest.fn(async (u: string, d: any) => postImpl(u, d)) } as any;
  }

  test("forwards creditsUsed from API response (#3351)", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        creditsUsed: 2,
        data: {
          web: [{ url: "https://example.com", title: "Example", description: "desc" }],
        },
      },
    };

    const http = makeHttp(() => mockResponse);
    const result = await search(http, { query: "example" });

    expect(result.creditsUsed).toBe(2);
    expect(result.web).toBeDefined();
    expect((result.web || []).length).toBe(1);
  });

  test("omits creditsUsed when API response does not include it", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        data: {
          web: [{ url: "https://example.com" }],
        },
      },
    };

    const http = makeHttp(() => mockResponse);
    const result = await search(http, { query: "example" });

    expect(result.creditsUsed).toBeUndefined();
  });

  test("forwards creditsUsed=0 from API response", async () => {
    const mockResponse = {
      status: 200,
      data: {
        success: true,
        creditsUsed: 0,
        data: {},
      },
    };

    const http = makeHttp(() => mockResponse);
    const result = await search(http, { query: "example" });

    expect(result.creditsUsed).toBe(0);
  });
});
