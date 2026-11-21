vi.mock("@mendable/firecrawl-rs", () => ({
  processSitemap: vi.fn(),
  validateRegexes: vi.fn(),
}));

import { parseSitemapUrl } from "../sitemap";

describe("parseSitemapUrl", () => {
  const baseUrl = "https://example.com/sitemaps/sitemap_index.xml";

  it("should parse valid absolute URLs", () => {
    const parsed = parseSitemapUrl("https://example.com/page-1");
    expect(parsed).not.toBeNull();
    expect(parsed?.href).toBe("https://example.com/page-1");
  });

  it("should resolve root-relative URLs using baseUrl", () => {
    const parsed = parseSitemapUrl("/sitemaps/child.xml", baseUrl);
    expect(parsed).not.toBeNull();
    expect(parsed?.href).toBe("https://example.com/sitemaps/child.xml");
  });

  it("should resolve relative paths using baseUrl", () => {
    const parsed = parseSitemapUrl(
      "products.xml",
      "https://example.com/sitemaps/",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.href).toBe("https://example.com/sitemaps/products.xml");
  });

  it("should trim surrounding whitespace", () => {
    const parsed = parseSitemapUrl("   https://example.com/trimmed   \n");
    expect(parsed).not.toBeNull();
    expect(parsed?.href).toBe("https://example.com/trimmed");
  });

  it("should return null for empty or whitespace-only strings", () => {
    expect(parseSitemapUrl("")).toBeNull();
    expect(parseSitemapUrl("   \n\t ")).toBeNull();
  });

  it("should return null for malformed URLs without throwing", () => {
    const logger = { warn: vi.fn() };
    const parsed = parseSitemapUrl("http://", undefined, logger as any);
    expect(parsed).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping malformed sitemap URL",
      expect.objectContaining({ url: "http://" }),
    );
  });

  it("should not resolve a malformed scheme-like entry against the base URL", () => {
    // `ht^tps://evil.example/x` is not a URL the parser accepts, but it looks
    // like an absolute one. Resolving it as a path keeps a bogus host in the
    // crawl: it would come back as https://example.com/ht^tps://evil.example/x
    // and pass the host check because the host really is the base host.
    expect(
      parseSitemapUrl("ht^tps://evil.example/x", "https://example.com/"),
    ).toBeNull();
    expect(
      parseSitemapUrl("example.com:80/page", "https://example.com/"),
    ).not.toBeNull();
    expect(
      parseSitemapUrl("only-a-path/page", "https://example.com/"),
    ).not.toBeNull();
  });

  it("should safely process mixed list without throwing when some entries are malformed", () => {
    const rawUrls = [
      "https://example.com/valid-1",
      "/relative-sitemap.xml",
      "http://",
      "   ",
      "https://example.com/valid-2",
    ];

    const results: URL[] = [];
    for (const raw of rawUrls) {
      const parsed = parseSitemapUrl(raw, baseUrl);
      if (parsed) {
        results.push(parsed);
      }
    }

    expect(results).toHaveLength(3);
    expect(results.map(u => u.href)).toEqual([
      "https://example.com/valid-1",
      "https://example.com/relative-sitemap.xml",
      "https://example.com/valid-2",
    ]);
  });
});
