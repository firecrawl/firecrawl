import { TEST_SUITE_WEBSITE } from "../lib";
import {
  asyncCrawl,
  asyncCrawlWaitForFinish,
  Identity,
  idmux,
  scrapeRaw,
  scrapeTimeout,
  TEST_API_URL,
} from "./lib";
import request from "./lib";
import { beforeAll, describe, expect, it } from "vitest";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "fast-crawl",
    credits: 100000,
  });
}, 10000);

describe("FAST_CRAWL: fast, parallel, unthrottled crawling", () => {
  it("crawls many pages in parallel (no 2-at-a-time clamp, no delay)", async () => {
    const { id } = await asyncCrawl(
      {
        url: TEST_SUITE_WEBSITE,
        limit: 25,
        maxConcurrency: 25,
        ignoreRobotsTxt: true,
        maxDiscoveryDepth: 2,
      },
      identity,
    );
    const result = await asyncCrawlWaitForFinish(id, identity);
    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    // Parallel crawl should collect a large share of the 25 allowed pages.
    // A serialized (delay=1) or clamped-to-2 crawl takes far longer and,
    // combined with the wait timeout, yields far fewer delivered pages.
    expect((result.data ?? []).length).toBeGreaterThanOrEqual(15);
  }, 10 * scrapeTimeout);

  it("does not return 429 for 15 concurrent scrapes", async () => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        scrapeRaw({ url: TEST_SUITE_WEBSITE, formats: ["markdown"] }, identity),
      ),
    );
    const statuses = responses.map(r => r.statusCode);
    expect(statuses.every(s => s === 200)).toBe(true);
  }, 10 * scrapeTimeout);
});
