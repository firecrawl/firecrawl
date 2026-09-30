import { describe, test, expect } from "@jest/globals";
import axios, { type AxiosAdapter } from "axios";
import { FirecrawlClient } from "../../../v2/client";
import { pinToApiOrigin } from "../../../utils/apiOrigin";

const API_URL = "https://api.firecrawl.dev";
const API_KEY = "fc-test";

const origins: Array<[string, string]> = [
  ["same origin", API_URL],
  ["cross host", "https://evil.example"],
  ["protocol-relative", "//evil.example"],
  ["different port", "https://api.firecrawl.dev:8443"],
  ["different scheme", "http://api.firecrawl.dev"],
  ["whitespace-prefixed", "\n https://evil.example"],
];

function makeClient(firstPage: (next: string) => unknown, lastPage: unknown, next: string) {
  const client = new FirecrawlClient({ apiKey: API_KEY, apiUrl: API_URL });
  const sent: Array<{ url: string; authorization: unknown }> = [];
  const adapter: AxiosAdapter = async config => {
    const url = axios.getUri(config);
    sent.push({ url, authorization: config.headers.Authorization });
    const data = new URL(url).searchParams.has("skip") ? lastPage : firstPage(next);
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  (client as any).http.instance.defaults.adapter = adapter;
  return { client, sent };
}

function expectPinned(sent: Array<{ url: string; authorization: unknown }>, path: string) {
  expect(sent).toHaveLength(2);
  expect(sent[1]!.url).toBe(`${API_URL}${path}?skip=10`);
  for (const req of sent) {
    expect(new URL(req.url).origin).toBe(API_URL);
    expect(req.url).not.toContain("evil.example");
    expect(req.authorization).toBe(`Bearer ${API_KEY}`);
  }
}

describe("v2 pagination pins next URLs to the api_url origin", () => {
  describe.each(origins)("%s next", (_label, origin) => {
    test("crawl status", async () => {
      const path = "/v2/crawl/abc";
      const { client, sent } = makeClient(
        next => ({ success: true, status: "completed", completed: 2, total: 2, next, data: [{ markdown: "a" }] }),
        { success: true, next: null, data: [{ markdown: "b" }] },
        `${origin}${path}?skip=10`,
      );
      const job = await client.getCrawlStatus("abc");
      expect(job.data).toHaveLength(2);
      expectPinned(sent, path);
    });

    test("batch scrape status", async () => {
      const path = "/v2/batch/scrape/abc";
      const { client, sent } = makeClient(
        next => ({ success: true, status: "completed", completed: 2, total: 2, next, data: [{ markdown: "a" }] }),
        { success: true, next: null, data: [{ markdown: "b" }] },
        `${origin}${path}?skip=10`,
      );
      const job = await client.getBatchScrapeStatus("abc");
      expect(job.data).toHaveLength(2);
      expectPinned(sent, path);
    });

    test("monitor check", async () => {
      const path = "/v2/monitor/m1/checks/c1";
      const { client, sent } = makeClient(
        next => ({ success: true, data: { id: "c1", pages: [{ url: "https://a.example" }], next } }),
        { success: true, data: { pages: [{ url: "https://b.example" }], next: null } },
        `${origin}${path}?skip=10`,
      );
      const check = await client.getMonitorCheck("m1", "c1");
      expect(check.pages).toHaveLength(2);
      expectPinned(sent, path);
    });
  });
});

describe("pinToApiOrigin", () => {
  test("rewrites absolute URLs onto the api origin, keeping path and query and dropping the fragment", () => {
    expect(pinToApiOrigin(API_URL, "https://evil.example/v2/crawl/abc?skip=10#frag")).toBe(
      `${API_URL}/v2/crawl/abc?skip=10`,
    );
    expect(pinToApiOrigin("http://localhost:3002", "https://evil.example:444/v2/crawl/abc?skip=10")).toBe(
      "http://localhost:3002/v2/crawl/abc?skip=10",
    );
    expect(pinToApiOrigin(API_URL, "\\\\evil.example/v2/crawl/abc")).toBe(`${API_URL}/v2/crawl/abc`);
    for (const url of ["\nhttps://evil.example/v2/crawl/abc", "h\tttps://evil.example/v2/crawl/abc", "\u0000 //evil.example/v2/crawl/abc", "/\\evil.example/v2/crawl/abc"]) {
      expect(pinToApiOrigin(API_URL, url)).toBe(`${API_URL}/v2/crawl/abc`);
    }
  });

  test("leaves relative URLs unchanged", () => {
    expect(pinToApiOrigin(API_URL, "/v2/crawl/abc?skip=10")).toBe("/v2/crawl/abc?skip=10");
  });

  test("throws when apiUrl is not absolute and the URL needs pinning", () => {
    expect(() => pinToApiOrigin("api.firecrawl.dev", "https://evil.example/v2/crawl/abc")).toThrow(
      "apiUrl must be an absolute URL",
    );
  });
});
