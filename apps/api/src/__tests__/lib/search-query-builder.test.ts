import { describe, it, expect } from "@jest/globals";
import {
  buildSearchQuery,
  getCategoryFromUrl,
  getDefaultResearchSites,
} from "../../lib/search-query-builder";

describe("Search Query Builder", () => {
  describe("buildSearchQuery", () => {
    it("should return base query when no categories provided", () => {
      const result = buildSearchQuery("machine learning");
      expect(result.query).toBe("machine learning");
      expect(result.categoryMap.size).toBe(0);
    });

    it("should return base query when empty categories array provided", () => {
      const result = buildSearchQuery("machine learning", []);
      expect(result.query).toBe("machine learning");
      expect(result.categoryMap.size).toBe(0);
    });

    it("should add GitHub filter for simple github category", () => {
      const result = buildSearchQuery("web scraping", ["github"]);
      expect(result.query).toBe("web scraping (site:github.com)");
      expect(result.categoryMap.get("github.com")).toBe("github");
      expect(result.categoryMap.size).toBe(1);
    });

    it("should add default research sites for simple research category", () => {
      const result = buildSearchQuery("neural networks", ["research"]);
      expect(result.query).toContain("neural networks (");
      expect(result.query).toContain("site:arxiv.org");
      expect(result.query).toContain("site:nature.com");
      expect(result.query).toContain("site:ieee.org");
      expect(result.query).toContain(" OR ");

      // Check category map
      expect(result.categoryMap.get("arxiv.org")).toBe("research");
      expect(result.categoryMap.get("nature.com")).toBe("research");
      expect(result.categoryMap.size).toBe(14); // All default research sites
    });

    it("should handle multiple simple categories", () => {
      const result = buildSearchQuery("firecrawl", ["github", "research"]);
      expect(result.query).toContain("firecrawl (");
      expect(result.query).toContain("site:github.com");
      expect(result.query).toContain("site:arxiv.org");
      expect(result.query).toContain(" OR ");

      expect(result.categoryMap.get("github.com")).toBe("github");
      expect(result.categoryMap.get("arxiv.org")).toBe("research");
      expect(result.categoryMap.size).toBe(15); // 1 GitHub + 14 research
    });

    it("should handle GitHub category as object", () => {
      const result = buildSearchQuery("code review", [{ type: "github" }]);
      expect(result.query).toBe("code review (site:github.com)");
      expect(result.categoryMap.get("github.com")).toBe("github");
    });

    it("should use custom research sites when provided", () => {
      const result = buildSearchQuery("quantum computing", [
        {
          type: "research",
          sites: ["arxiv.org", "nature.com"],
        },
      ]);
      expect(result.query).toBe(
        "quantum computing (site:arxiv.org OR site:nature.com)",
      );
      expect(result.categoryMap.size).toBe(2);
      expect(result.categoryMap.get("arxiv.org")).toBe("research");
      expect(result.categoryMap.get("nature.com")).toBe("research");
    });

    it("should handle mixed string and object categories", () => {
      const result = buildSearchQuery("AI research", [
        "github",
        {
          type: "research",
          sites: ["arxiv.org"],
        },
      ]);
      expect(result.query).toBe(
        "AI research (site:github.com OR site:arxiv.org)",
      );
      expect(result.categoryMap.get("github.com")).toBe("github");
      expect(result.categoryMap.get("arxiv.org")).toBe("research");
      expect(result.categoryMap.size).toBe(2);
    });

    it("should handle special characters in base query", () => {
      const result = buildSearchQuery("C++ programming", ["github"]);
      expect(result.query).toBe("C++ programming (site:github.com)");
    });

    it("should handle quotes in base query", () => {
      const result = buildSearchQuery('"exact phrase" search', ["github"]);
      expect(result.query).toBe('"exact phrase" search (site:github.com)');
    });

    it("should ignore invalid category types", () => {
      const result = buildSearchQuery("test", ["invalid" as any]);
      expect(result.query).toBe("test");
      expect(result.categoryMap.size).toBe(0);
    });

    it("should ignore invalid category objects", () => {
      const result = buildSearchQuery("test", [{ type: "invalid" as any }]);
      expect(result.query).toBe("test");
      expect(result.categoryMap.size).toBe(0);
    });
  });

  describe("getCategoryFromUrl", () => {
    const categoryMap = new Map([
      ["github.com", "github"],
      ["arxiv.org", "research"],
      ["nature.com", "research"],
      ["ieee.org", "research"],
    ]);

    it("should identify GitHub URLs", () => {
      expect(
        getCategoryFromUrl("https://github.com/user/repo", categoryMap),
      ).toBe("github");
      expect(
        getCategoryFromUrl("https://www.github.com/user/repo", categoryMap),
      ).toBe("github");
      expect(
        getCategoryFromUrl("http://github.com/user/repo", categoryMap),
      ).toBe("github");
    });

    it("should identify research URLs from category map", () => {
      expect(
        getCategoryFromUrl("https://arxiv.org/abs/2024.12345", categoryMap),
      ).toBe("research");
      expect(
        getCategoryFromUrl(
          "https://www.nature.com/articles/s12345",
          categoryMap,
        ),
      ).toBe("research");
      expect(
        getCategoryFromUrl(
          "https://ieeexplore.ieee.org/document/12345",
          categoryMap,
        ),
      ).toBe("research");
    });

    it("should return undefined for unknown URLs", () => {
      expect(
        getCategoryFromUrl("https://example.com", categoryMap),
      ).toBeUndefined();
      expect(
        getCategoryFromUrl("https://google.com", categoryMap),
      ).toBeUndefined();
    });

    it("should handle invalid URLs gracefully", () => {
      expect(getCategoryFromUrl("not-a-url", categoryMap)).toBeUndefined();
      expect(getCategoryFromUrl("", categoryMap)).toBeUndefined();
      expect(
        getCategoryFromUrl("ftp://example.com", categoryMap),
      ).toBeUndefined();
    });

    it("should be case-insensitive", () => {
      expect(
        getCategoryFromUrl("https://GitHub.com/user/repo", categoryMap),
      ).toBe("github");
      expect(
        getCategoryFromUrl("https://ArXiv.org/abs/2024.12345", categoryMap),
      ).toBe("research");
    });

    it("should work with subdomains", () => {
      expect(
        getCategoryFromUrl("https://api.github.com/user/repo", categoryMap),
      ).toBe("github");
      expect(
        getCategoryFromUrl(
          "https://export.arxiv.org/abs/2024.12345",
          categoryMap,
        ),
      ).toBe("research");
    });

    it("should work with empty category map", () => {
      const emptyMap = new Map<string, string>();
      // GitHub is hardcoded, so it should still work
      expect(getCategoryFromUrl("https://github.com/user/repo", emptyMap)).toBe(
        "github",
      );
      // Others should return undefined
      expect(
        getCategoryFromUrl("https://arxiv.org/abs/2024.12345", emptyMap),
      ).toBeUndefined();
    });
  });

  describe("getDefaultResearchSites", () => {
    it("should return array of default research sites", () => {
      const sites = getDefaultResearchSites();
      expect(Array.isArray(sites)).toBe(true);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites).toContain("arxiv.org");
      expect(sites).toContain("nature.com");
      expect(sites).toContain("ieee.org");
      expect(sites).toContain("scholar.google.com");
    });

    it("should return a new array each time (no mutation)", () => {
      const sites1 = getDefaultResearchSites();
      const sites2 = getDefaultResearchSites();
      expect(sites1).not.toBe(sites2); // Different array instances
      expect(sites1).toEqual(sites2); // But same content
    });
  });

  describe("Integration tests", () => {
    it("should handle complex real-world query", () => {
      const result = buildSearchQuery(
        'machine learning "neural networks" site:stackoverflow.com',
        ["github", "research"],
      );

      // Should append category filters to existing query
      expect(result.query).toContain(
        'machine learning "neural networks" site:stackoverflow.com',
      );
      expect(result.query).toContain("(site:github.com OR site:arxiv.org");

      // Check URLs can be categorized
      const githubUrl = "https://github.com/tensorflow/tensorflow";
      const arxivUrl = "https://arxiv.org/abs/2024.12345";

      expect(getCategoryFromUrl(githubUrl, result.categoryMap)).toBe("github");
      expect(getCategoryFromUrl(arxivUrl, result.categoryMap)).toBe("research");
    });

    it("should handle empty query with categories", () => {
      const result = buildSearchQuery("", ["github"]);
      expect(result.query).toBe(" (site:github.com)");
    });

    it("should build correct query for multiple custom research sites", () => {
      const customSites = [
        "pubmed.ncbi.nlm.nih.gov",
        "biorxiv.org",
        "medrxiv.org",
      ];
      const result = buildSearchQuery("COVID-19 research", [
        { type: "research", sites: customSites },
      ]);

      expect(result.query).toBe(
        "COVID-19 research (site:pubmed.ncbi.nlm.nih.gov OR site:biorxiv.org OR site:medrxiv.org)",
      );

      // All sites should be mapped to research
      customSites.forEach(site => {
        expect(result.categoryMap.get(site)).toBe("research");
      });
    });
  });
});
