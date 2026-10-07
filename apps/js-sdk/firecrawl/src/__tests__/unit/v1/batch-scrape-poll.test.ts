import { describe, test, expect, jest, afterEach, beforeEach } from "@jest/globals";
import axios from "axios";
import FirecrawlApp from "../../../v1";

const API_URL = "https://api.firecrawl.dev";
const API_KEY = "fc-test";

const scrapingPage = () => ({ success: true, status: "scraping", total: 2, completed: 0, data: [] });
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

function mockPoll(path: string, nextOrigin = API_URL) {
  const sent: string[] = [];
  let polls = 0;
  jest.spyOn(axios, "get").mockImplementation(async (url: string) => {
    sent.push(url);
    if (new URL(url).searchParams.has("skip")) return { status: 200, data: lastPage() };
    polls++;
    return { status: 200, data: polls === 1 ? scrapingPage() : completedPage(`${nextOrigin}${path}?skip=1`) };
  });
  return sent;
}

describe("v1 batch scrape waits on the batch scrape status endpoint", () => {
  const app = new FirecrawlApp({ apiKey: API_KEY, apiUrl: API_URL });

  beforeEach(() => {
    jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("batchScrapeUrls polls /v1/batch/scrape/{id} and follows pinned next pages", async () => {
    const post = jest.spyOn(axios, "post").mockResolvedValue({ status: 200, data: { success: true, id: "abc" } });
    const path = "/v1/batch/scrape/abc";
    const sent = mockPoll(path, "https://evil.example");

    const res: any = await app.batchScrapeUrls(["https://example.com", "https://example.org"], {});

    expect(post.mock.calls[0][0]).toBe(`${API_URL}/v1/batch/scrape`);
    expect(sent).toEqual([`${API_URL}${path}`, `${API_URL}${path}`, `${API_URL}${path}?skip=1`]);
    expect(sent.some(url => url.includes("/v1/crawl/"))).toBe(false);
    expect(res.status).toBe("completed");
    expect(res.data).toHaveLength(2);
  });

  test("batchScrapeUrls reports batch scrape failures as batch scrape errors", async () => {
    jest.spyOn(axios, "post").mockResolvedValue({ status: 200, data: { success: true, id: "abc" } });
    const sent: string[] = [];
    jest.spyOn(axios, "get").mockImplementation(async (url: string) => {
      sent.push(url);
      return { status: 200, data: { success: true, status: "failed", data: [] } };
    });

    await expect(app.batchScrapeUrls(["https://example.com"], {})).rejects.toThrow("Batch scrape job failed or was stopped");
    expect(sent.every(url => url === `${API_URL}/v1/batch/scrape/abc`)).toBe(true);
  });

  test("monitorJobStatus still polls /v1/crawl/{id} by default", async () => {
    const path = "/v1/crawl/abc";
    const sent = mockPoll(path);

    const res: any = await app.monitorJobStatus("abc", app.prepareHeaders(), 0);

    expect(sent).toEqual([`${API_URL}${path}`, `${API_URL}${path}`, `${API_URL}${path}?skip=1`]);
    expect(res.data).toHaveLength(2);
  });

  test("monitorJobStatus polls /v1/batch/scrape/{id} for batch jobs", async () => {
    const path = "/v1/batch/scrape/abc";
    const sent = mockPoll(path);

    const res: any = await app.monitorJobStatus("abc", app.prepareHeaders(), 0, "batch");

    expect(sent).toEqual([`${API_URL}${path}`, `${API_URL}${path}`, `${API_URL}${path}?skip=1`]);
    expect(res.data).toHaveLength(2);
  });
});
