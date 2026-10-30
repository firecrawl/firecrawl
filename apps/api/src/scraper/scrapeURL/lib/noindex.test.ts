import { hasNoindexDirective } from "./noindex";

describe("hasNoindexDirective", () => {
  it("detects noindex in a robots string", () => {
    expect(hasNoindexDirective({ robots: "noindex, nofollow" })).toBe(true);
  });

  it("detects noindex when robots is an array from repeated tags", () => {
    expect(hasNoindexDirective({ robots: ["index", "NOINDEX"] })).toBe(true);
    expect(hasNoindexDirective({ robots: ["index", "follow"] })).toBe(false);
  });

  it("detects FirecrawlAgent tags keyed by raw name from the native extractor", () => {
    expect(hasNoindexDirective({ FirecrawlAgent: "noindex" })).toBe(true);
    expect(hasNoindexDirective({ FireCrawlAgent: ["noindex"] })).toBe(true);
  });

  it("detects the cheerio fallback firecrawlAgentRobots field", () => {
    expect(hasNoindexDirective({ firecrawlAgentRobots: "noindex" })).toBe(true);
  });

  it("ignores unrelated tags and missing metadata", () => {
    expect(hasNoindexDirective({ description: "noindex" })).toBe(false);
    expect(hasNoindexDirective({ robots: "index, follow" })).toBe(false);
    expect(hasNoindexDirective(undefined)).toBe(false);
  });
});
