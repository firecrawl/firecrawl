import { describe, it, expect } from "vitest";
import {
  collectSearchResultCategories,
  countSearchResultsBySource,
} from "../entities";
import type { SearchV2Response, WebSearchResult } from "../entities";

const web = (url: string, category?: string): WebSearchResult => {
  const result: WebSearchResult = {
    url,
    title: url,
    description: "",
  };
  if (category) {
    result.category = category;
  }
  return result;
};

describe("collectSearchResultCategories", () => {
  it("keys the serving vertical by group and 1-indexed position", () => {
    const response: SearchV2Response = {
      web: [
        web("https://github.com/firecrawl/firecrawl", "github"),
        web("https://example.com/"),
        web("https://arxiv.org/abs/1", "research"),
      ],
    };

    expect(collectSearchResultCategories(response)).toEqual({
      web: { "1": "github", "3": "research" },
    });
  });

  it("tags every developer hit, which is the whole web group", () => {
    // The developer category is exclusive, so its hits ARE data.web —
    // renumbered from 1 after threat filtering.
    const response: SearchV2Response = {
      web: [
        web("https://github.com/firecrawl/firecrawl/issues/1", "developer"),
        web("https://docs.firecrawl.dev/", "developer"),
      ],
    };

    expect(collectSearchResultCategories(response)).toEqual({
      web: { "1": "developer", "2": "developer" },
    });
  });

  it("distinguishes an untagged search from an absent one", () => {
    // `{}` is a claim: the search ran and nothing carried a category. NULL in
    // the column is the separate claim that the row cannot answer at all.
    expect(
      collectSearchResultCategories({ web: [web("https://example.com/")] }),
    ).toEqual({});
    expect(collectSearchResultCategories({})).toEqual({});
  });

  it("omits groups with no tagged results rather than emitting empty maps", () => {
    const response: SearchV2Response = {
      web: [web("https://github.com/firecrawl/cli", "github")],
      news: [{ url: "https://news.example/a", title: "A" }],
      images: [{ url: "https://img.example/a.png", title: "A" }],
    };

    expect(collectSearchResultCategories(response)).toEqual({
      web: { "1": "github" },
    });
  });

  it("keys news positions independently of web", () => {
    const response: SearchV2Response = {
      web: [web("https://example.com/")],
      news: [
        { url: "https://news.example/a", title: "A", category: "research" },
      ],
    };

    expect(collectSearchResultCategories(response)).toEqual({
      news: { "1": "research" },
    });
  });

  it("ignores non-string and empty categories", () => {
    const nonStringCategory: WebSearchResult = {
      url: "https://b.example/",
      title: "",
      description: "",
    };
    Object.defineProperty(nonStringCategory, "category", {
      value: 7,
      enumerable: true,
    });
    const response: SearchV2Response = {
      web: [
        { url: "https://a.example/", title: "", description: "", category: "" },
        nonStringCategory,
        web("https://c.example/", "pdf"),
      ],
    };

    expect(collectSearchResultCategories(response)).toEqual({
      web: { "3": "pdf" },
    });
  });

  it("counts tools only when provider discovery ran", () => {
    expect(
      countSearchResultsBySource({ web: [web("https://a.example/")] }),
    ).toEqual({
      web: 1,
      images: 0,
      news: 0,
    });
    expect(
      countSearchResultsBySource({
        tools: [
          { provider: "fred", capability: "series/search", description: "" },
        ],
      }),
    ).toEqual({ web: 0, images: 0, news: 0, tools: 1 });
    expect(
      countSearchResultsBySource({
        skills: [
          {
            id: "official/search",
            name: "Search",
            description: "Find records",
            source: "official",
          },
        ],
      }),
    ).toEqual({ web: 0, images: 0, news: 0, skills: 1 });
    expect(countSearchResultsBySource({ skills: [] })).toEqual({
      web: 0,
      images: 0,
      news: 0,
      skills: 0,
    });
  });

  it("positions line up with the counts feedback bounds against", () => {
    const response: SearchV2Response = {
      web: [web("https://a.example/", "developer"), web("https://b.example/")],
      news: [{ url: "https://news.example/a", title: "A" }],
    };

    const counts = countSearchResultsBySource(response);
    const categories = collectSearchResultCategories(response);

    for (const source of ["web", "images", "news"] as const) {
      const byPosition = categories[source];
      if (!byPosition) {
        continue;
      }
      for (const position of Object.keys(byPosition)) {
        expect(Number(position)).toBeLessThanOrEqual(counts[source]);
      }
    }
  });
});
