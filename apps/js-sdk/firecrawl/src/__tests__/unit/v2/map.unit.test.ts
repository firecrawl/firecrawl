import { describe, test, expect, jest } from "@jest/globals";
import { map } from "../../../v2/methods/map";

describe("JS SDK v2 map method", () => {
  test("throws when URL is empty string", async () => {
    const http = { post: jest.fn() } as any;
    await expect(map(http, "")).rejects.toThrow("URL cannot be empty");
  });

  test("throws when URL is whitespace-only", async () => {
    const http = { post: jest.fn() } as any;
    await expect(map(http, "   ")).rejects.toThrow("URL cannot be empty");
  });

  test("posts to /v2/map with trimmed URL", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, links: ["https://example.com/page1"] },
    }));
    const http = { post } as any;

    await map(http, "  https://example.com  ");

    expect(post).toHaveBeenCalledWith(
      "/v2/map",
      expect.objectContaining({ url: "https://example.com" }),
      {},
    );
  });

  test("returns links as SearchResultWeb array", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: {
        success: true,
        links: [
          "https://example.com/page1",
          { url: "https://example.com/page2", title: "Page 2", description: "Desc" },
        ],
      },
    }));
    const http = { post } as any;

    const result = await map(http, "https://example.com");

    expect(result.links).toHaveLength(2);
    expect(result.links[0]).toEqual({ url: "https://example.com/page1" });
    expect(result.links[1]).toEqual({
      url: "https://example.com/page2",
      title: "Page 2",
      description: "Desc",
    });
  });

  test("returns empty links array when response has no links", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true },
    }));
    const http = { post } as any;

    const result = await map(http, "https://example.com");
    expect(result.links).toEqual([]);
  });

  test("includes timeout in Axios options when provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, links: [] },
    }));
    const http = { post } as any;

    await map(http, "https://example.com", { timeout: 30000 });

    expect(post).toHaveBeenCalledWith(
      "/v2/map",
      expect.objectContaining({ timeout: 30000 }),
      { timeoutMs: 35000 },
    );
  });

  test("does not include timeoutMs when timeout is not provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, links: [] },
    }));
    const http = { post } as any;

    await map(http, "https://example.com");

    expect(post).toHaveBeenCalledWith("/v2/map", expect.any(Object), {});
  });

  test("includes search option in payload when provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, links: [] },
    }));
    const http = { post } as any;

    await map(http, "https://example.com", { search: "blog" });

    expect(post).toHaveBeenCalledWith(
      "/v2/map",
      expect.objectContaining({ search: "blog" }),
      {},
    );
  });

  test("includes limit in payload when provided", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: true, links: [] },
    }));
    const http = { post } as any;

    await map(http, "https://example.com", { limit: 100 });

    expect(post).toHaveBeenCalledWith(
      "/v2/map",
      expect.objectContaining({ limit: 100 }),
      {},
    );
  });

  test("throws SdkError on non-200 response", async () => {
    const post = jest.fn(async () => ({
      status: 400,
      data: { success: false, error: "Invalid URL" },
    }));
    const http = { post } as any;

    await expect(map(http, "https://example.com")).rejects.toThrow();
  });

  test("throws SdkError when success is false", async () => {
    const post = jest.fn(async () => ({
      status: 200,
      data: { success: false, error: "Internal error" },
    }));
    const http = { post } as any;

    await expect(map(http, "https://example.com")).rejects.toThrow();
  });
});
