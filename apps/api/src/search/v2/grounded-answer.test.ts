import {
  pickSynthesisContexts,
  buildSynthesisMessages,
  buildSnippets,
} from "./grounded-answer";
import { WebSearchResult } from "../../lib/entities";

function wr(
  url: string,
  markdown: string,
  position?: number,
): WebSearchResult {
  return { url, title: url, description: "", position, markdown };
}

describe("pickSynthesisContexts", () => {
  it("keeps the top-N results that have markdown, in position order", () => {
    const results = [
      wr("https://a", "alpha", 0),
      wr("https://b", "beta", 1),
      wr("https://c", "gamma", 2),
    ];
    expect(pickSynthesisContexts(results, 2, 1000)).toEqual(["alpha", "beta"]);
  });

  it("skips results without markdown", () => {
    const results = [
      wr("https://a", "alpha", 0),
      { url: "https://b", title: "b", description: "" },
      wr("https://c", "gamma", 2),
    ];
    expect(pickSynthesisContexts(results, 5, 1000)).toEqual(["alpha", "gamma"]);
  });

  it("truncates each context to maxChars", () => {
    const results = [wr("https://a", "x".repeat(5000), 0)];
    const [ctx] = pickSynthesisContexts(results, 1, 100);
    expect(ctx!.length).toBe(100);
  });

  it("returns nothing when no result has markdown", () => {
    const results = [{ url: "https://a", title: "a", description: "" }];
    expect(pickSynthesisContexts(results, 5, 1000)).toEqual([]);
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
