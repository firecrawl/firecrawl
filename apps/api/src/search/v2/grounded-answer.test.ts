import {
  gatherAnswerSources,
  buildSynthesisMessages,
  buildSnippets,
  extractCitations,
  decidePolicy,
} from "./grounded-answer";
import { WebSearchResult } from "../../lib/entities";

function wr(
  url: string,
  passages: string[],
  markdown = "md",
): WebSearchResult {
  return {
    url,
    title: url,
    description: "",
    markdown,
    passages: passages.map(text => ({ text, score: 1, source: 0 })),
  };
}

describe("gatherAnswerSources", () => {
  it("gathers every passage-bearing result, numbered by markdown order", () => {
    const out = gatherAnswerSources([
      wr("https://a", ["a1", "a2"]),
      wr("https://b", ["b1"]),
      { url: "https://c", title: "c", description: "" },
    ]);
    expect(out).toEqual([
      { n: 1, url: "https://a", title: "https://a", text: "a1\n\na2" },
      { n: 2, url: "https://b", title: "https://b", text: "b1" },
    ]);
  });

  it("skips results with markdown but no passages", () => {
    const out = gatherAnswerSources([
      wr("https://a", ["a1"]),
      { url: "https://b", title: "b", description: "", markdown: "md" },
    ]);
    expect(out.map(s => s.url)).toEqual(["https://a"]);
  });

  it("returns nothing when nothing has passages", () => {
    expect(gatherAnswerSources([{ url: "u", title: "u", description: "" }])).toEqual([]);
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
  it("emits a system + user message carrying query and source text", () => {
    const msgs = buildSynthesisMessages("what is firecrawl", [
      { n: 1, url: "u", title: "t", text: "Firecrawl converts pages to markdown." },
    ]);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("what is firecrawl");
    expect(msgs[1].content).toContain("[1] Firecrawl converts pages to markdown.");
  });

  it("labels each source by its n, not array index", () => {
    const msgs = buildSynthesisMessages("q", [
      { n: 3, url: "u3", title: "t3", text: "ctx C" },
      { n: 5, url: "u5", title: "t5", text: "ctx E" },
    ]);
    expect(msgs[1].content).toContain("[3] ctx C");
    expect(msgs[1].content).toContain("[5] ctx E");
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