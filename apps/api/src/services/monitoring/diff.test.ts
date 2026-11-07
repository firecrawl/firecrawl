import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkdownChangeDiff } from "../../lib/change-tracking-diff";
import { diffMonitorJson, diffMonitorMarkdown } from "./diff";

describe("markdown change tracking diff", () => {
  it("treats command substitution syntax as text", () => {
    const marker = join(
      tmpdir(),
      `firecrawl-change-diff-${process.pid}-${Date.now()}`,
    );
    const current = `visible text $(touch ${marker}) and \`touch ${marker}.bt\``;

    try {
      const result = createMarkdownChangeDiff("visible text", current);

      expect(result).toBeDefined();
      expect(result?.text).toContain("$(touch");
      expect(result?.text).toContain("`touch");
      expect(result?.json.files).toBeInstanceOf(Array);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}.bt`)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
      rmSync(`${marker}.bt`, { force: true });
    }
  });

  it("uses the shell-free diff path for monitor markdown diffs", () => {
    const marker = join(
      tmpdir(),
      `firecrawl-monitor-diff-${process.pid}-${Date.now()}`,
    );

    try {
      const result = diffMonitorMarkdown(
        "baseline",
        `changed $(touch ${marker})`,
      );

      if (result.status !== "changed") {
        throw new Error("Expected monitor markdown diff to change");
      }
      expect(result.text).toContain("$(touch");
      expect(result.json.files).toBeInstanceOf(Array);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});

describe("diffMonitorJson", () => {
  it("returns `same` when every value matches", () => {
    expect(
      diffMonitorJson(
        { name: "Pro", price: "$19", tags: ["a", "b"] },
        { name: "Pro", price: "$19", tags: ["a", "b"] },
      ),
    ).toEqual({ kind: "json", status: "same" });
  });

  it("returns `same` regardless of object key order", () => {
    expect(diffMonitorJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual({
      kind: "json",
      status: "same",
    });
  });

  it("reports a single change for a top-level primitive that differs", () => {
    const result = diffMonitorJson({ price: "$19" }, { price: "$24" });
    expect(result).toEqual({
      kind: "json",
      status: "changed",
      json: { price: { previous: "$19", current: "$24" } },
    });
  });

  it("recurses into nested objects so unchanged sibling fields stay quiet", () => {
    // Regression: previously the whole `details` object was reported as
    // changed when only `description` differed, which rendered every
    // unchanged sibling field with strikethrough in the UI.
    const previous = {
      location: "Oslo, Norway",
      details: {
        direction: "forward",
        description: "Clocks go forward 1 hour",
        next_change_date: "",
      },
    };
    const current = {
      location: "United States",
      details: {
        direction: "forward",
        description: "",
        next_change_date: "",
      },
    };

    const result = diffMonitorJson(previous, current);

    expect(result).toEqual({
      kind: "json",
      status: "changed",
      json: {
        location: { previous: "Oslo, Norway", current: "United States" },
        "details.description": {
          previous: "Clocks go forward 1 hour",
          current: "",
        },
      },
    });
  });

  it("emits per-index paths when an array element changes", () => {
    const previous = {
      plans: [
        { name: "Starter", price: "$19" },
        { name: "Pro", price: "$49" },
      ],
    };
    const current = {
      plans: [
        { name: "Starter", price: "$24" },
        { name: "Pro", price: "$49" },
      ],
    };

    expect(diffMonitorJson(previous, current)).toEqual({
      kind: "json",
      status: "changed",
      json: {
        "plans[0].price": { previous: "$19", current: "$24" },
      },
    });
  });

  it("reports added and removed array elements at their index", () => {
    const previous = { tags: ["a", "b"] };
    const current = { tags: ["a", "b", "c"] };

    expect(diffMonitorJson(previous, current)).toEqual({
      kind: "json",
      status: "changed",
      json: {
        "tags[2]": { previous: undefined, current: "c" },
      },
    });
  });

  it("records the whole subtree when the value type diverges", () => {
    // object → primitive should NOT recurse: there's nothing to walk in
    // parallel, and the user wants to see "this whole thing became a
    // string" as one entry.
    const previous = { details: { foo: 1, bar: 2 } };
    const current = { details: "n/a" };

    expect(diffMonitorJson(previous, current)).toEqual({
      kind: "json",
      status: "changed",
      json: {
        details: { previous: { foo: 1, bar: 2 }, current: "n/a" },
      },
    });
  });

  it("treats fields that became null as a single leaf change", () => {
    const previous = { contact: { email: "x@y.com" } };
    const current = { contact: null };

    expect(diffMonitorJson(previous, current)).toEqual({
      kind: "json",
      status: "changed",
      json: {
        contact: { previous: { email: "x@y.com" }, current: null },
      },
    });
  });

  it("ignores NFC-equivalent string differences", () => {
    // "é" can be encoded as a single codepoint (U+00E9) or as e + combining
    // acute accent (U+0065 U+0301). The diff should treat them as equal.
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(diffMonitorJson({ name: composed }, { name: decomposed })).toEqual({
      kind: "json",
      status: "same",
    });
  });

  it("ignores whitespace-only differences in string values", () => {
    // Regression: LLM extractions of the same content often differ only
    // in incidental whitespace (extra spaces, trailing newlines, NBSP
    // from HTML rendering, etc.). Those shouldn't be reported as field
    // changes — they drown out real signal.
    const previous = {
      headline: "Power AI agents with  clean web data",
      cta: "Start for free\n",
      // Non-breaking space (U+00A0) instead of a regular space — common
      // when scraping rendered HTML.
      subhead: "The API\u00a0to scrape the web",
      // BOM at the start of the string.
      tagline: "\ufeffNo more brittle scrapers",
    };
    const current = {
      headline: "Power AI agents with clean web data",
      cta: "Start for free",
      subhead: "The API to scrape the web",
      tagline: "No more brittle scrapers",
    };

    expect(diffMonitorJson(previous, current)).toEqual({
      kind: "json",
      status: "same",
    });
  });

  it("still detects real content changes after whitespace normalization", () => {
    // Sanity check: the whitespace normalization shouldn't make every
    // string look equal.
    expect(
      diffMonitorJson(
        { headline: "Power AI agents with clean web data" },
        { headline: "Power AI agents with structured web data" },
      ),
    ).toEqual({
      kind: "json",
      status: "changed",
      json: {
        headline: {
          previous: "Power AI agents with clean web data",
          current: "Power AI agents with structured web data",
        },
      },
    });
  });

  it("handles undefined inputs as empty objects", () => {
    expect(diffMonitorJson(undefined, undefined)).toEqual({
      kind: "json",
      status: "same",
    });
    expect(diffMonitorJson(undefined, { a: 1 })).toEqual({
      kind: "json",
      status: "changed",
      json: { a: { previous: undefined, current: 1 } },
    });
  });
});
