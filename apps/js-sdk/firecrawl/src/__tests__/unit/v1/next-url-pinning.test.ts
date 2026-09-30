import { describe, test, expect, jest, afterEach } from "@jest/globals";
import axios from "axios";
import FirecrawlApp from "../../../v1";

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

function mockGet(respond: (url: URL) => unknown) {
  const sent: Array<{ url: string; authorization: unknown }> = [];
  jest.spyOn(axios, "get").mockImplementation(async (url: string, config?: any) => {
    sent.push({ url, authorization: config?.headers?.Authorization });
    return { status: 200, data: respond(new URL(url)) };
  });
  return sent;
}

function expectPinned(sent: Array<{ url: string; authorization: unknown }>, expectedUrls: string[]) {
  expect(sent.map(req => req.url)).toEqual(expectedUrls);
  for (const req of sent) {
    expect(new URL(req.url).origin).toBe(API_URL);
    expect(req.url).not.toContain("evil.example");
    expect(req.authorization).toBe(`Bearer ${API_KEY}`);
  }
}

const completedPage = (next: string) => ({
  success: true,
  status: "completed",
  total: 2,
  completed: 2,
  expiresAt: "2030-01-01T00:00:00Z",
  data: [{ markdown: "a" }],
  next,
});
const lastPage = () => ({ success: true, status: "completed", data: [{ markdown: "b" }] });

describe("v1 pins next URLs to the api_url origin", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(origins)("%s next", (_label, origin) => {
    const app = new FirecrawlApp({ apiKey: API_KEY, apiUrl: API_URL });

    test.each([
      ["checkCrawlStatus", "/v1/crawl/abc"],
      ["checkBatchScrapeStatus", "/v1/batch/scrape/abc"],
    ] as const)("%s getAllData follows server next", async (method, path) => {
      const sent = mockGet(url => (url.searchParams.has("skip") ? lastPage() : completedPage(`${origin}${path}?skip=10`)));
      const res: any = await app[method]("abc", true);
      expect(res.data).toHaveLength(2);
      expectPinned(sent, [`${API_URL}${path}`, `${API_URL}${path}?skip=10`]);
    });

    test.each([
      ["checkCrawlStatus", "/v1/crawl/abc"],
      ["checkBatchScrapeStatus", "/v1/batch/scrape/abc"],
    ] as const)("%s caller-supplied nextURL", async (method, path) => {
      const sent = mockGet(lastPage);
      await app[method]("abc", false, `${origin}${path}?skip=10`);
      expectPinned(sent, [`${API_URL}${path}?skip=10`]);
    });

    test("monitorJobStatus follows server next", async () => {
      const path = "/v1/crawl/abc";
      const sent = mockGet(url => (url.searchParams.has("skip") ? lastPage() : completedPage(`${origin}${path}?skip=10`)));
      const res: any = await app.monitorJobStatus("abc", app.prepareHeaders(), 0);
      expect(res.data).toHaveLength(2);
      expectPinned(sent, [`${API_URL}${path}`, `${API_URL}${path}?skip=10`]);
    });
  });
});
