import { resolveCrawlerLink } from "../link-normalization";

describe("resolveCrawlerLink", () => {
  it("resolves relative links against the crawl base URL", () => {
    expect(
      resolveCrawlerLink("/docs/getting-started", "https://example.com/docs"),
    )?.toMatchObject({
      href: "https://example.com/docs/getting-started",
      pathname: "/docs/getting-started",
    });
  });

  it("preserves absolute links", () => {
    expect(
      resolveCrawlerLink(
        "https://example.com/docs/api",
        "https://example.com/docs",
      ),
    )?.toMatchObject({
      href: "https://example.com/docs/api",
      pathname: "/docs/api",
    });
  });

  it("returns null for malformed links", () => {
    expect(resolveCrawlerLink("https://exa mple.com", "https://example.com"))
      .toBeNull();
  });

  it("returns null for non-web schemes", () => {
    expect(resolveCrawlerLink("mailto:test@example.com", "https://example.com"))
      .toBeNull();
    expect(resolveCrawlerLink("ftp://example.com/file.txt", "https://example.com"))
      .toBeNull();
  });

  it("returns null for empty and fragment-only hrefs", () => {
    expect(resolveCrawlerLink("", "https://example.com/docs")).toBeNull();
    expect(resolveCrawlerLink("   ", "https://example.com/docs")).toBeNull();
    expect(resolveCrawlerLink("#overview", "https://example.com/docs"))
      .toBeNull();
  });
});
