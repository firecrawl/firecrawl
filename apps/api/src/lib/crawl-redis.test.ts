import { randomUUID } from "node:crypto";
import { redisEvictConnection } from "../services/redis";

vi.mock("../scraper/WebScraper/crawler", () => ({ WebCrawler: class {} }));

import {
  generateURLPermutations,
  lockURL,
  type StoredCrawl,
} from "./crawl-redis";

describe("lockURL", () => {
  it("does not exceed the crawl limit when URLs are locked concurrently", async () => {
    const id = `lock-url-limit-${randomUUID()}`;
    const visitedKey = `crawl:${id}:visited`;
    const visitedUniqueKey = `crawl:${id}:visited_unique`;
    const sc = {
      crawlerOptions: { limit: 1, deduplicateSimilarURLs: false },
      scrapeOptions: {},
      internalOptions: {},
      team_id: "test-team",
      createdAt: Date.now(),
    } as StoredCrawl;

    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          lockURL(id, sc, `https://example.com/page-${index}`),
        ),
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await redisEvictConnection.scard(visitedKey)).toBe(1);
      expect(await redisEvictConnection.scard(visitedUniqueKey)).toBe(1);
    } finally {
      await redisEvictConnection.del(visitedKey, visitedUniqueKey);
    }
  });
});

describe("generateURLPermutations", () => {
  it("generates permutations correctly", () => {
    const bareHttps = generateURLPermutations("https://firecrawl.dev").map(
      x => x.href,
    );
    expect(bareHttps.length).toBe(16);
    expect(bareHttps.includes("https://firecrawl.dev/")).toBe(true);
    expect(bareHttps.includes("https://firecrawl.dev/index.html")).toBe(true);
    expect(bareHttps.includes("https://firecrawl.dev/index.php")).toBe(true);
    expect(bareHttps.includes("https://www.firecrawl.dev/")).toBe(true);
    expect(bareHttps.includes("https://www.firecrawl.dev/index.html")).toBe(
      true,
    );
    expect(bareHttps.includes("https://www.firecrawl.dev/index.php")).toBe(
      true,
    );
    expect(bareHttps.includes("http://firecrawl.dev/")).toBe(true);
    expect(bareHttps.includes("http://firecrawl.dev/index.html")).toBe(true);
    expect(bareHttps.includes("http://firecrawl.dev/index.php")).toBe(true);
    expect(bareHttps.includes("http://www.firecrawl.dev/")).toBe(true);
    expect(bareHttps.includes("http://www.firecrawl.dev/index.html")).toBe(
      true,
    );
    expect(bareHttps.includes("http://www.firecrawl.dev/index.php")).toBe(true);

    const bareHttp = generateURLPermutations("http://firecrawl.dev").map(
      x => x.href,
    );
    expect(bareHttp.length).toBe(16);
    expect(bareHttp.includes("https://firecrawl.dev/")).toBe(true);
    expect(bareHttp.includes("https://firecrawl.dev/index.html")).toBe(true);
    expect(bareHttp.includes("https://firecrawl.dev/index.php")).toBe(true);
    expect(bareHttp.includes("https://www.firecrawl.dev/")).toBe(true);
    expect(bareHttp.includes("https://www.firecrawl.dev/index.html")).toBe(
      true,
    );
    expect(bareHttp.includes("https://www.firecrawl.dev/index.php")).toBe(true);
    expect(bareHttp.includes("http://firecrawl.dev/")).toBe(true);
    expect(bareHttp.includes("http://firecrawl.dev/index.html")).toBe(true);
    expect(bareHttp.includes("http://firecrawl.dev/index.php")).toBe(true);
    expect(bareHttp.includes("http://www.firecrawl.dev/")).toBe(true);
    expect(bareHttp.includes("http://www.firecrawl.dev/index.html")).toBe(true);
    expect(bareHttp.includes("http://www.firecrawl.dev/index.php")).toBe(true);

    const wwwHttps = generateURLPermutations("https://www.firecrawl.dev").map(
      x => x.href,
    );
    expect(wwwHttps.length).toBe(16);
    expect(wwwHttps.includes("https://firecrawl.dev/")).toBe(true);
    expect(wwwHttps.includes("https://firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttps.includes("https://firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttps.includes("https://www.firecrawl.dev/")).toBe(true);
    expect(wwwHttps.includes("https://www.firecrawl.dev/index.html")).toBe(
      true,
    );
    expect(wwwHttps.includes("https://www.firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttps.includes("http://firecrawl.dev/")).toBe(true);
    expect(wwwHttps.includes("http://firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttps.includes("http://firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttps.includes("http://www.firecrawl.dev/")).toBe(true);
    expect(wwwHttps.includes("http://www.firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttps.includes("http://www.firecrawl.dev/index.php")).toBe(true);

    const wwwHttp = generateURLPermutations("http://www.firecrawl.dev").map(
      x => x.href,
    );
    expect(wwwHttp.length).toBe(16);
    expect(wwwHttp.includes("https://firecrawl.dev/")).toBe(true);
    expect(wwwHttp.includes("https://firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttp.includes("https://firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttp.includes("https://www.firecrawl.dev/")).toBe(true);
    expect(wwwHttp.includes("https://www.firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttp.includes("https://www.firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttp.includes("http://firecrawl.dev/")).toBe(true);
    expect(wwwHttp.includes("http://firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttp.includes("http://firecrawl.dev/index.php")).toBe(true);
    expect(wwwHttp.includes("http://www.firecrawl.dev/")).toBe(true);
    expect(wwwHttp.includes("http://www.firecrawl.dev/index.html")).toBe(true);
    expect(wwwHttp.includes("http://www.firecrawl.dev/index.php")).toBe(true);
  });
});
