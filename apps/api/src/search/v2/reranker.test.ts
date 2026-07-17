import { buildRerankDocument, reorderResultsByScores } from "./reranker";
import { WebSearchResult } from "../../lib/entities";

function r(
  url: string,
  title: string,
  description: string,
): WebSearchResult {
  return { url, title, description };
}

describe("buildRerankDocument", () => {
  it("joins title and description", () => {
    const doc = buildRerankDocument(
      r("https://a", "Firecrawl Docs", "Turn sites into markdown"),
    );
    expect(doc).toBe("Firecrawl Docs \n Turn sites into markdown");
  });

  it("drops an empty description instead of leaving a dangling separator", () => {
    const doc = buildRerankDocument(r("https://a", "Only A Title", ""));
    expect(doc).toBe("Only A Title");
  });
});

describe("reorderResultsByScores", () => {
  it("sorts results by score descending", () => {
    const results = [
      r("https://a", "A", "a"),
      r("https://b", "B", "b"),
      r("https://c", "C", "c"),
      r("https://d", "D", "d"),
    ];
    const scores = [0.1, 0.9, 0.5, 0.3];
    const ordered = reorderResultsByScores(results, scores);
    expect(ordered.map(x => x.url)).toEqual([
      "https://b",
      "https://c",
      "https://d",
      "https://a",
    ]);
  });

  it("keeps a zero score (it is a real rank, not missing)", () => {
    const results = [r("https://a", "A", "a"), r("https://b", "B", "b")];
    const ordered = reorderResultsByScores(results, [0, 0.5]);
    expect(ordered.map(x => x.url)).toEqual(["https://b", "https://a"]);
  });

  it("pushes results with a missing score to the back", () => {
    const results = [
      r("https://a", "A", "a"),
      r("https://b", "B", "b"),
      r("https://c", "C", "c"),
    ];
    const ordered = reorderResultsByScores(results, [0.2, undefined, 0.8]);
    expect(ordered.map(x => x.url)).toEqual([
      "https://c",
      "https://a",
      "https://b",
    ]);
  });
});
