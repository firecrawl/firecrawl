import { generateURLPermutations } from "./crawl-redis";

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
