import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import FirecrawlApp from "../../../v1";
import { mockFetch } from "../helpers/mockFetch";

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

function mockPoll(path: string, nextOrigin = API_URL, posts: string[] = []) {
  const sent: string[] = [];
  let polls = 0;
  mockFetch(req => {
    if (req.method === "post") {
      posts.push(req.url);
      return { data: { success: true, id: "abc" } };
    }
    sent.push(req.url);
    if (new URL(req.url).searchParams.has("skip")) return { data: lastPage() };
    polls++;
    return { data: polls === 1 ? scrapingPage() : completedPage(`${nextOrigin}${path}?skip=1`) };
  });
  return sent;
}

describe("v1 batch scrape waits on the batch scrape status endpoint", () => {
  const app = new FirecrawlApp({ apiKey: API_KEY, apiUrl: API_URL });

  beforeEach(() => {
    vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("batchScrapeUrls polls /v1/batch/scrape/{id} and follows pinned next pages", async () => {
    const posts: string[] = [];
    const path = "/v1/batch/scrape/abc";
    const sent = mockPoll(path, "https://evil.example", posts);

    const res: any = await app.batchScrapeUrls(["https://example.com", "https://example.org"], {});

    expect(posts[0]).toBe(`${API_URL}/v1/batch/scrape`);
    expect(sent).toEqual([`${API_URL}${path}`, `${API_URL}${path}`, `${API_URL}${path}?skip=1`]);
    expect(sent.some(url => url.includes("/v1/crawl/"))).toBe(false);
    expect(res.status).toBe("completed");
    expect(res.data).toHaveLength(2);
  });

  test("batchScrapeUrls reports batch scrape failures as batch scrape errors", async () => {
    const sent: string[] = [];
    mockFetch(req => {
      if (req.method === "post") return { data: { success: true, id: "abc" } };
      sent.push(req.url);
      return { data: { success: true, status: "failed", data: [] } };
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

  test("monitorJobStatus retries a status poll after the server closes the socket", async () => {
    const path = "/v1/crawl/abc";
    const sent = mockPoll(path);
    const realFetch = globalThis.fetch;
    let dropped = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (!dropped) {
        dropped = true;
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        });
      }
      return realFetch(url, init);
    });

    const res: any = await app.monitorJobStatus("abc", app.prepareHeaders(), 0);

    expect(dropped).toBe(true);
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
