import { filterMapResultsList } from "../map-utils";

describe("filterMapResultsList", () => {
  const baseUrl = "https://example.com/docs";

  const mapDocs = [
    { url: "https://example.com/docs/intro", title: "Intro" },
    { url: "https://example.com/blog/news", title: "Blog" },
    { url: "https://sub.example.com/docs/sub", title: "Subdomain" },
    { url: "https://external.com/article", title: "External" },
    { url: "https://partner.org/guide", title: "Partner" },
  ];

  const stringLinks = [
    "https://example.com/docs/intro",
    "https://example.com/blog/news",
    "https://sub.example.com/docs/sub",
    "https://external.com/article",
    "https://partner.org/guide",
  ];

  describe("when allowExternalLinks is true", () => {
    it("should preserve external domains and subdomains for MapDocument objects", () => {
      const filtered = filterMapResultsList(mapDocs, baseUrl, {
        allowExternalLinks: true,
        includeSubdomains: false,
        filterByPath: true,
      });

      const urls = filtered.map(x => (typeof x === "string" ? x : x.url));
      expect(urls).toContain("https://external.com/article");
      expect(urls).toContain("https://partner.org/guide");
      expect(urls).toContain("https://sub.example.com/docs/sub");
      expect(urls).toContain("https://example.com/docs/intro");
      expect(urls).toContain("https://example.com/blog/news");
      expect(urls).toHaveLength(5);
    });

    it("should preserve external domains for string arrays", () => {
      const filtered = filterMapResultsList(stringLinks, baseUrl, {
        allowExternalLinks: true,
      });

      expect(filtered).toContain("https://external.com/article");
      expect(filtered).toContain("https://partner.org/guide");
      expect(filtered).toHaveLength(5);
    });

    it("should handle empty or invalid links safely", () => {
      const mixed = ["https://external.com/ok", "invalid-url", ""];
      const filtered = filterMapResultsList(mixed, baseUrl, {
        allowExternalLinks: true,
      });
      expect(filtered).toContain("https://external.com/ok");
    });
  });

  describe("when allowExternalLinks is false", () => {
    it("should filter out external domains and enforce path filtering if enabled", () => {
      const filtered = filterMapResultsList(mapDocs, baseUrl, {
        allowExternalLinks: false,
        includeSubdomains: false,
        filterByPath: true,
      });

      const urls = filtered.map(x => (typeof x === "string" ? x : x.url));
      expect(urls).toEqual(["https://example.com/docs/intro"]);
      expect(urls).not.toContain("https://external.com/article");
      expect(urls).not.toContain("https://partner.org/guide");
      expect(urls).not.toContain("https://sub.example.com/docs/sub");
      expect(urls).not.toContain("https://example.com/blog/news");
    });

    it("should filter out subdomains if includeSubdomains is false", () => {
      const filtered = filterMapResultsList(mapDocs, baseUrl, {
        allowExternalLinks: false,
        includeSubdomains: false,
        filterByPath: false,
      });

      const urls = filtered.map(x => (typeof x === "string" ? x : x.url));
      expect(urls).toContain("https://example.com/docs/intro");
      expect(urls).toContain("https://example.com/blog/news");
      expect(urls).not.toContain("https://sub.example.com/docs/sub");
      expect(urls).not.toContain("https://external.com/article");
    });

    it("should allow subdomains if includeSubdomains is true", () => {
      const filtered = filterMapResultsList(mapDocs, baseUrl, {
        allowExternalLinks: false,
        includeSubdomains: true,
        filterByPath: false,
      });

      const urls = filtered.map(x => (typeof x === "string" ? x : x.url));
      expect(urls).toContain("https://example.com/docs/intro");
      expect(urls).toContain("https://example.com/blog/news");
      expect(urls).toContain("https://sub.example.com/docs/sub");
      expect(urls).not.toContain("https://external.com/article");
    });
  });
});
