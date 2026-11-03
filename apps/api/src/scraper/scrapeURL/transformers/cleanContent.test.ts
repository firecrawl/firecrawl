import { config } from "../../../config";
import {
  applyBlockRemovals,
  isProtectedBlock,
  REMOVED_SHARE_WARNING_THRESHOLD,
  selectCleanContentRoute,
  splitMarkdownBlocks,
  stripHeadingAnchorLinks,
} from "./cleanContent";

describe("splitMarkdownBlocks", () => {
  it("splits on blank lines", () => {
    expect(
      splitMarkdownBlocks("# Title\n\nFirst para\nstill first\n\n\n- a\n- b"),
    ).toEqual(["# Title", "First para\nstill first", "- a\n- b"]);
  });

  it("keeps a fenced code block with blank lines in one block", () => {
    const md = "Intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter";
    expect(splitMarkdownBlocks(md)).toEqual([
      "Intro",
      "```js\nconst a = 1;\n\nconst b = 2;\n```",
      "After",
    ]);
  });

  it("closes a fence only on a bare marker at least as long as the opener", () => {
    const md = "~~~~\na\n\n~~~\nstill code\n\n~~~~\n\nAfter";
    expect(splitMarkdownBlocks(md)).toEqual([
      "~~~~\na\n\n~~~\nstill code\n\n~~~~",
      "After",
    ]);
  });

  it("does not open a fence on an inline triple-backtick line", () => {
    const md = "```inline``` code\n\nNext";
    expect(splitMarkdownBlocks(md)).toEqual(["```inline``` code", "Next"]);
  });

  it("returns no blocks for empty markdown", () => {
    expect(splitMarkdownBlocks("\n\n")).toEqual([]);
  });
});

describe("isProtectedBlock", () => {
  it.each([
    ["ATX heading", "## Install"],
    ["heading inside a block", "### Options\nSome text"],
    ["setext heading", "Install\n======="],
    ["fenced code", "```\nnpm i\n```"],
    ["tilde fence", "~~~\ncode\n~~~"],
    ["table", "| a | b |\n| --- | :-: |\n| 1 | 2 |"],
    ["table without outer pipes", "a | b\n--- | ---\n1 | 2"],
  ])("protects a %s", (_, block) => {
    expect(isProtectedBlock(block)).toBe(true);
  });

  it.each([
    ["paragraph", "Just some text."],
    ["list", "- [Home](/)\n- [Docs](/docs)"],
    ["thematic break", "---"],
    ["hashtag text", "#hashtag at the start"],
    ["pipe in prose", "this | that"],
  ])("does not protect a %s", (_, block) => {
    expect(isProtectedBlock(block)).toBe(false);
  });
});

describe("stripHeadingAnchorLinks", () => {
  it("removes a 'Copy link to section' link and keeps the heading text", () => {
    expect(
      stripHeadingAnchorLinks(
        "## [Local Development](https://example.com/docs#local) [Copy link to section](https://example.com/docs#local)",
      ),
    ).toBe("## [Local Development](https://example.com/docs#local)");
  });

  it.each([
    "#",
    "¶",
    "",
    "Permalink",
    "Link to this heading",
    "Direct link to Install",
  ])("removes an anchor labelled %j", label => {
    expect(stripHeadingAnchorLinks(`### Install [${label}](#install)`)).toBe(
      "### Install",
    );
  });

  it("removes a leading anchor", () => {
    expect(stripHeadingAnchorLinks("## [#](#setup) Setup")).toBe("## Setup");
  });

  it("keeps ordinary links in headings and anchors outside headings", () => {
    expect(stripHeadingAnchorLinks("## See [the guide](/guide#start)")).toBe(
      "## See [the guide](/guide#start)",
    );
    expect(stripHeadingAnchorLinks("Text [Copy link to section](#a)")).toBe(
      "Text [Copy link to section](#a)",
    );
  });

  it("leaves blocks with fenced code untouched", () => {
    const block = "```md\n## A [#](#a)\n```";
    expect(stripHeadingAnchorLinks(block)).toBe(block);
  });
});

describe("applyBlockRemovals", () => {
  const blocks = [
    "[Skip to content](#main)",
    "# Title",
    "The main article paragraph, which is long enough to matter here.",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "Footer links",
  ];
  const original = blocks.join("\n\n");

  it("removes the requested blocks and keeps the rest verbatim", () => {
    const result = applyBlockRemovals(original, blocks, [0, 4]);
    expect(result.markdown).toBe(blocks.slice(1, 4).join("\n\n"));
    expect(result.warning).toBeUndefined();
    expect(result.stats).toMatchObject({
      totalBlocks: 5,
      removedBlocks: 2,
      protectedHits: 0,
    });
  });

  it("ignores and counts ids that point at headings, code or tables", () => {
    const result = applyBlockRemovals(original, blocks, [0, 1, 3]);
    expect(result.markdown).toBe(blocks.slice(1).join("\n\n"));
    expect(result.stats.removedBlocks).toBe(1);
    expect(result.stats.protectedHits).toBe(2);
  });

  it("ignores ids that are out of range, duplicated or not integers", () => {
    const result = applyBlockRemovals(original, blocks, [
      0,
      0,
      -1,
      5,
      1.5,
      "4",
    ]);
    expect(result.stats.removedBlocks).toBe(1);
    expect(result.markdown).toBe(blocks.slice(1).join("\n\n"));
  });

  it("keeps the original and warns when nothing is removed", () => {
    for (const ids of [[], [1, 3], undefined, "nope"]) {
      const result = applyBlockRemovals(original, blocks, ids);
      expect(result.markdown).toBe(original);
      expect(result.warning).toContain("found nothing to remove");
    }
  });

  it("keeps the original and warns when every block would be removed", () => {
    const plain = ["Nav", "Text", "Footer"];
    const result = applyBlockRemovals(plain.join("\n\n"), plain, [0, 1, 2]);
    expect(result.markdown).toBe(plain.join("\n\n"));
    expect(result.warning).toContain("whole page");
  });

  it("warns when most of the page's text is removed", () => {
    const page = ["x".repeat(80), "Kept", "y".repeat(16)];
    const result = applyBlockRemovals(page.join("\n\n"), page, [0, 2]);
    expect(result.stats.removedShare).toBeGreaterThan(
      REMOVED_SHARE_WARNING_THRESHOLD,
    );
    expect(result.markdown).toBe("Kept");
    expect(result.warning).toContain("removed 96% of the page's text");
  });
});

describe("selectCleanContentRoute", () => {
  const saved = {
    mode: config.ONLY_CLEAN_CONTENT_MODE,
    percent: config.ONLY_CLEAN_CONTENT_PERCENT,
  };
  afterEach(() => {
    config.ONLY_CLEAN_CONTENT_MODE = saved.mode;
    config.ONLY_CLEAN_CONTENT_PERCENT = saved.percent;
  });

  it("uses the legacy cleaner when the mode is off", () => {
    config.ONLY_CLEAN_CONTENT_MODE = "off";
    config.ONLY_CLEAN_CONTENT_PERCENT = 100;
    expect(selectCleanContentRoute("team", () => 0)).toBe("legacy");
  });

  it("samples shadow requests by the given percentage", () => {
    config.ONLY_CLEAN_CONTENT_MODE = "shadow";
    config.ONLY_CLEAN_CONTENT_PERCENT = 25;
    expect(selectCleanContentRoute("team", () => 0.2)).toBe("shadow");
    expect(selectCleanContentRoute("team", () => 0.3)).toBe("legacy");
  });

  it("samples teams in on mode, stably as the percentage grows", () => {
    config.ONLY_CLEAN_CONTENT_MODE = "on";
    const teams = Array.from({ length: 200 }, (_, i) => `team-${i}`);
    config.ONLY_CLEAN_CONTENT_PERCENT = 20;
    const at20 = teams.filter(t => selectCleanContentRoute(t) === "deletion");
    config.ONLY_CLEAN_CONTENT_PERCENT = 60;
    const at60 = new Set(
      teams.filter(t => selectCleanContentRoute(t) === "deletion"),
    );
    expect(at20.length).toBeGreaterThan(0);
    expect(at60.size).toBeGreaterThan(at20.length);
    expect(at20.every(t => at60.has(t))).toBe(true);
    config.ONLY_CLEAN_CONTENT_PERCENT = 0;
    expect(selectCleanContentRoute("team-1")).toBe("legacy");
    config.ONLY_CLEAN_CONTENT_PERCENT = 100;
    expect(selectCleanContentRoute("team-1")).toBe("deletion");
  });
});
