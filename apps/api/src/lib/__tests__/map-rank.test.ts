import { rankAndCapMapResults } from "../map-rank";
import { MapDocument } from "../../controllers/v2/types";

describe("rankAndCapMapResults", () => {
  const results: MapDocument[] = [
    { url: "https://example.com/contact" },
    { url: "https://example.com/about" },
    { url: "https://example.com/blog/post-about-firecrawl" },
  ];

  it("ranks by relevance before applying the limit (#3335)", () => {
    // The only relevant page sits at index 2, beyond the limit. Ranking must
    // run before the cutoff, otherwise it is sliced away before being scored.
    const out = rankAndCapMapResults(results, "blog post", 2);

    expect(out.length).toBe(2);
    expect(out.map(r => r.url)).toContain(
      "https://example.com/blog/post-about-firecrawl",
    );
    // Most relevant result ranks first.
    expect(out[0].url).toBe("https://example.com/blog/post-about-firecrawl");
  });

  it("preserves order and only applies the cutoff when there is no search", () => {
    const out = rankAndCapMapResults(results, undefined, 2);

    expect(out.map(r => r.url)).toEqual([
      "https://example.com/contact",
      "https://example.com/about",
    ]);
  });

  it("returns all results when the limit is not exceeded", () => {
    const out = rankAndCapMapResults(results, undefined, 10);

    expect(out.length).toBe(results.length);
  });
});
