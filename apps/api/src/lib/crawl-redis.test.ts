import { generateURLPermutations, crawlToCrawler } from "./crawl-redis";
import { config } from "../config";

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

describe("crawlToCrawler FAST_CRAWL", () => {
  const sc = {
    originUrl: "https://example.com",
    crawlerOptions: {},
    scrapeOptions: {},
    internalOptions: {},
  } as any;

  afterEach(() => {
    delete (config as any).FAST_CRAWL;
  });

  it("forces ignoreRobotsTxt and skips the robots fetch when FAST_CRAWL", async () => {
    (config as any).FAST_CRAWL = true;
    const crawler = crawlToCrawler("fast-crawl-job-1", sc, null);
    expect((crawler as any).ignoreRobotsTxt).toBe(true);
    await expect(crawler.getRobotsTxt()).resolves.toBe("");
  });

  it("keeps the flag-gated robots behavior when FAST_CRAWL is unset", () => {
    const crawler = crawlToCrawler("fast-crawl-job-2", sc, null);
    expect((crawler as any).ignoreRobotsTxt).toBe(false);
  });
});
