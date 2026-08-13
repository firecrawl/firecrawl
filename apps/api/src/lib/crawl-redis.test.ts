import { generateURLPermutations, lockURL, StoredCrawl } from "./crawl-redis";
import { redisEvictConnection } from "../services/redis";

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

describe("lockURL", () => {
  it("does not let concurrent callers exceed crawlerOptions.limit", async () => {
    const id = "test-lockurl-concurrency-limit";
    const limit = 5;
    const concurrency = 20;
    const sc = {
      crawlerOptions: { limit },
    } as StoredCrawl;

    await redisEvictConnection.del(
      "crawl:" + id + ":visited",
      "crawl:" + id + ":visited_unique",
    );

    try {
      const results = await Promise.all(
        Array.from({ length: concurrency }, (_, i) =>
          lockURL(id, sc, `https://firecrawl.dev/page-${i}`),
        ),
      );

      expect(results.filter(Boolean).length).toBe(limit);
      expect(
        await redisEvictConnection.scard("crawl:" + id + ":visited_unique"),
      ).toBe(limit);
    } finally {
      await redisEvictConnection.del(
        "crawl:" + id + ":visited",
        "crawl:" + id + ":visited_unique",
      );
    }
  });
});
