import { describe, expect, it } from "vitest";
import {
  canonicalizeSearchUrl,
  filterAndRankWebResults,
  isArxivPdfUrl,
  isPdfLikeUrl,
  stripSearchDiagnostics,
} from "../../search/quality";

describe("search result quality", () => {
  it("unwraps redirects and removes tracking parameters", () => {
    expect(
      canonicalizeSearchUrl(
        "https://redirect.example/?url=https%3A%2F%2Fgithub.com%2Ffirecrawl%2Ffirecrawl%3Futm_source%3Dtest",
      ),
    ).toBe("https://github.com/firecrawl/firecrawl");
  });

  it("recognizes extensionless arXiv PDF routes", () => {
    expect(isArxivPdfUrl("https://arxiv.org/pdf/2307.04644")).toBe(true);
    expect(isPdfLikeUrl("https://arxiv.org/pdf/2307.04644")).toBe(true);
    expect(isArxivPdfUrl("https://arxiv.org/abs/2307.04644")).toBe(false);
  });

  it("rewrites arXiv abstract URLs for explicit PDF searches", () => {
    expect(
      canonicalizeSearchUrl("https://arxiv.org/abs/2307.04644", "pdf"),
    ).toBe("https://arxiv.org/pdf/2307.04644");
  });

  it("hard-enforces GitHub and include-domain constraints", () => {
    const results = filterAndRankWebResults(
      [
        {
          url: "https://github.com/firecrawl/firecrawl",
          title: "Firecrawl",
          description: "developer API",
        },
        {
          url: "https://example.com/firecrawl",
          title: "Firecrawl mirror",
          description: "developer API",
        },
      ],
      {
        query: "firecrawl",
        profiles: ["developer"],
        categories: ["github"],
        includeDomains: ["github.com"],
      },
    );
    expect(results.map(result => result.url)).toEqual([
      "https://github.com/firecrawl/firecrawl",
    ]);
  });

  it("deduplicates canonical URLs and ranks trusted exact matches first", () => {
    const results = filterAndRankWebResults(
      [
        {
          url: "https://example.com/unrelated",
          title: "Unrelated",
          description: "something else",
          __search: { score: 1 },
        },
        {
          url: "https://github.com/firecrawl/firecrawl?utm_source=x",
          title: "Firecrawl repository",
          description: "web scraping API",
          __search: { score: 2, engine: "github" },
        },
        {
          url: "https://github.com/firecrawl/firecrawl",
          title: "Duplicate",
          description: "",
        },
      ],
      { query: "firecrawl web scraping", profiles: ["developer"] },
    );
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://github.com/firecrawl/firecrawl");
  });

  it("removes internal engine diagnostics before returning results", () => {
    expect(
      stripSearchDiagnostics([
        {
          url: "https://example.com",
          title: "Example",
          description: "",
          __search: { engine: "bing", score: 2 },
        },
      ]),
    ).toEqual([
      { url: "https://example.com", title: "Example", description: "" },
    ]);
  });
});
