import {
  pickSynthesisSources,
  buildSynthesisMessages,
  buildSnippets,
  extractCitations,
  decidePolicy,
} from "./grounded-answer";
import { WebSearchResult } from "../../lib/entities";

function wr(
  url: string,
  markdown: string,
  position?: number,
): WebSearchResult {
  return { url, title: url, description: "", position, markdown };
}

describe("pickSynthesisSources", () => {
  it("keeps the top-N markdown results, numbered 1..N with identity", () => {
    const results = [
      wr("https://a", "alpha", 0),
      wr("https://b", "beta", 1),
      wr("https://c", "gamma", 2),
    ];
    const out = pickSynthesisSources(results, 2, 1000);
    expect(out.map(s => ({ n: s.n, url: s.url, text: s.text }))).toEqual([
      { n: 1, url: "https://a", text: "alpha" },
      { n: 2, url: "https://b", text: "beta" },
    ]);
  });

  it("skips results without markdown (n reflects position among kept)", () => {
    const results = [
      wr("https://a", "alpha", 0),
      { url: "https://b", title: "b", description: "" },
      wr("https://c", "gamma", 2),
    ];
    const out = pickSynthesisSources(results, 5, 1000);
    expect(out.map(s => s.n)).toEqual([1, 2]);
    expect(out.map(s => s.url)).toEqual(["https://a", "https://c"]);
  });

  it("truncates each text to maxChars", () => {
    const [s] = pickSynthesisSources([wr("https://a", "x".repeat(5000), 0)], 1, 100);
    expect(s!.text.length).toBe(100);
  });

  it("returns nothing when no result has markdown", () => {
    expect(
      pickSynthesisSources(
        [{ url: "https://a", title: "a", description: "" }],
        5,
        1000,
      ),
    ).toEqual([]);
  });
});

describe("extractCitations", () => {
  it("collects [N] markers from the answer", () => {
    expect(extractCitations("Firecrawl [1] is a tool [2] for scraping", 3)).toEqual([
      1, 2,
    ]);
  });

  it("handles grouped citations like [1, 2, 3]", () => {
    expect(extractCitations("...for LLMs [1, 2, 3].", 3)).toEqual([1, 2, 3]);
    expect(extractCitations("mixed [2] and [1, 3]", 3)).toEqual([1, 2, 3]);
  });

  it("dedupes repeated citations", () => {
    expect(extractCitations("a [1] b [1] c [1]", 3)).toEqual([1]);
  });

  it("drops citations outside the valid source range", () => {
    expect(extractCitations("x [1] y [9] z [0]", 3)).toEqual([1]);
  });

  it("returns nothing when there are no citations", () => {
    expect(extractCitations("no citations here", 3)).toEqual([]);
  });
});

describe("buildSnippets", () => {
  it("joins title and description", () => {
    expect(
      buildSnippets([
        { url: "u", title: "Firecrawl", description: "scrapes the web" },
      ]),
    ).toEqual(["Firecrawl — scrapes the web"]);
  });

  it("returns title only when description is empty", () => {
    expect(
      buildSnippets([{ url: "u", title: "Only Title", description: "" }]),
    ).toEqual(["Only Title"]);
  });
});

describe("buildSynthesisMessages", () => {
  it("emits a system + user message carrying query and contexts", () => {
    const msgs = buildSynthesisMessages("what is firecrawl", [
      "Firecrawl converts pages to markdown.",
    ]);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("what is firecrawl");
    expect(msgs[1].content).toContain("Firecrawl converts pages to markdown.");
  });

  it("joins multiple contexts", () => {
    const msgs = buildSynthesisMessages("q", ["ctx A", "ctx B"]);
    expect(msgs[1].content).toContain("ctx A");
    expect(msgs[1].content).toContain("ctx B");
  });
});

describe("decidePolicy", () => {
  it("accepts when grounded", () => {
    expect(decidePolicy(0.71, true, 0.3)).toBe("accept");
    expect(decidePolicy(0.4, true, 0.3)).toBe("accept");
  });
  it("regenerates when not grounded but above the floor", () => {
    expect(decidePolicy(0.5, false, 0.3)).toBe("regen");
    expect(decidePolicy(0.3, false, 0.3)).toBe("regen");
  });
  it("abstains immediately below the floor", () => {
    expect(decidePolicy(0.29, false, 0.3)).toBe("abstain");
    expect(decidePolicy(0.05, false, 0.3)).toBe("abstain");
  });
});