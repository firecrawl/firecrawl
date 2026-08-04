import {
  extractSitePathFilters,
  rankSitePathMatchesFirst,
} from "./search-query-builder";

describe("extractSitePathFilters", () => {
  it("rewrites a path-scoped site: operator to its hostname", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "site:example.com/docs installation guide",
    );
    expect(query).toBe("site:example.com installation guide");
    expect(pathPrefixes).toEqual(["example.com/docs"]);
  });

  it("keeps deeper paths as a single prefix", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "site:github.com/example/repo SECURITY.md",
    );
    expect(query).toBe("site:github.com SECURITY.md");
    expect(pathPrefixes).toEqual(["github.com/example/repo"]);
  });

  it("leaves hostname-only site: operators untouched", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "site:example.com installation guide",
    );
    expect(query).toBe("site:example.com installation guide");
    expect(pathPrefixes).toEqual([]);
  });

  it("strips a bare trailing slash without recording a prefix", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "site:example.com/ installation guide",
    );
    expect(query).toBe("site:example.com installation guide");
    expect(pathPrefixes).toEqual([]);
  });

  it("leaves negated site: operators untouched", () => {
    const input = "widgets -site:example.com/forum";
    const { query, pathPrefixes } = extractSitePathFilters(input);
    expect(query).toBe(input);
    expect(pathPrefixes).toEqual([]);
  });

  it("handles multiple and parenthesized operators", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "(site:example.com/docs OR site:example.org/kb) setup",
    );
    expect(query).toBe("(site:example.com OR site:example.org) setup");
    expect(pathPrefixes).toEqual(["example.com/docs", "example.org/kb"]);
  });

  it("strips protocols and www from recorded prefixes", () => {
    const { query, pathPrefixes } = extractSitePathFilters(
      "site:https://www.example.com/docs/api reference",
    );
    expect(query).toBe("site:www.example.com reference");
    expect(pathPrefixes).toEqual(["example.com/docs/api"]);
  });

  it("ignores site: values that are not hostnames", () => {
    const input = "site:localhost/admin dashboard";
    const { query, pathPrefixes } = extractSitePathFilters(input);
    expect(query).toBe(input);
    expect(pathPrefixes).toEqual([]);
  });
});

describe("rankSitePathMatchesFirst", () => {
  const results = [
    { url: "https://example.com/blog/post" },
    { url: "https://example.com/docs/setup" },
    { url: "https://www.example.com/docs" },
    { url: "https://example.com/pricing" },
  ];

  it("moves results under the path prefix to the front, preserving order", () => {
    const ranked = rankSitePathMatchesFirst(results, ["example.com/docs"]);
    expect(ranked.map(r => r.url)).toEqual([
      "https://example.com/docs/setup",
      "https://www.example.com/docs",
      "https://example.com/blog/post",
      "https://example.com/pricing",
    ]);
  });

  it("does not treat sibling paths sharing a prefix string as matches", () => {
    const ranked = rankSitePathMatchesFirst(
      [
        { url: "https://example.com/docs-old/setup" },
        { url: "https://example.com/docs/setup" },
      ],
      ["example.com/docs"],
    );
    expect(ranked[0].url).toBe("https://example.com/docs/setup");
    expect(
      rankSitePathMatchesFirst(
        [{ url: "https://example.com/docs-old/setup" }],
        ["example.com/docs"],
      ),
    ).toEqual([{ url: "https://example.com/docs-old/setup" }]);
  });

  it("matches subdomains of the prefix host", () => {
    const ranked = rankSitePathMatchesFirst(
      [
        { url: "https://example.com/other" },
        { url: "https://docs.example.com/kb/article" },
      ],
      ["example.com/kb"],
    );
    expect(ranked[0].url).toBe("https://docs.example.com/kb/article");
  });

  it("returns results unchanged when no prefixes are given", () => {
    expect(rankSitePathMatchesFirst(results, [])).toBe(results);
  });

  it("returns results unchanged when nothing matches", () => {
    const ranked = rankSitePathMatchesFirst(results, ["example.net/docs"]);
    expect(ranked).toEqual(results);
  });

  it("skips results with missing or unparseable URLs", () => {
    const mixed = [
      { url: undefined },
      { url: "not a url" },
      { url: "https://example.com/docs/setup" },
    ];
    const ranked = rankSitePathMatchesFirst(mixed, ["example.com/docs"]);
    expect(ranked[0].url).toBe("https://example.com/docs/setup");
  });
});
