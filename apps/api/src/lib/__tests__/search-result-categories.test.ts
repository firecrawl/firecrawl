import { describe, it, expect } from "vitest";
import {
  collectSearchResultCategories,
  countSearchResultsBySource,
  type SearchV2Response,
} from "../entities";

const web = (url: string, category?: string) => ({
  url,
  title: url,
  description: "",
  ...(category ? { category } : {}),
});

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
    const response = {
      web: [
        { url: "https://a.example/", title: "", description: "", category: "" },
        {
          url: "https://b.example/",
          title: "",
          description: "",
          category: 7 as unknown as string,
        },
        web("https://c.example/", "pdf"),
      ],
    } as SearchV2Response;

    expect(collectSearchResultCategories(response)).toEqual({
      web: { "3": "pdf" },
    });
  });

  it("positions line up with the counts feedback bounds against", () => {
    const response: SearchV2Response = {
      web: [web("https://a.example/", "developer"), web("https://b.example/")],
      news: [{ url: "https://news.example/a", title: "A" }],
    };

    const counts = countSearchResultsBySource(response);
    const categories = collectSearchResultCategories(response);

    for (const [source, byPosition] of Object.entries(categories)) {
      for (const position of Object.keys(byPosition)) {
        expect(Number(position)).toBeLessThanOrEqual(
          counts[source as keyof typeof counts],
        );
      }
    }
  });
});
