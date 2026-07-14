import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  groundCitations,
  locateQuote,
  splitCitedExtraction,
  wrapSchemaWithCitations,
  type GroundingBlockPage,
} from "../citations";

// Real fire-pdf response (include_blocks) for a 3-page document assembled
// from public SEC-filing pages in the ParseBench corpus (Home Depot,
// Coca-Cola, USPS 10-Ks) — 25 blocks, 20 with markdown spans.
const fixture: { markdown: string; pages: GroundingBlockPage[] } = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "firepdf-blocks-10k.json"), "utf8"),
);

/** Quote taken from the Nth block that actually carries a span on the page. */
function quoteFromBlock(pageIdx: number, spannedIdx: number, len = 60): string {
  const spanned = fixture.pages[pageIdx]!.blocks.filter(b => b.markdown_span);
  const block = spanned[spannedIdx]!;
  const [start, end] = block.markdown_span as [number, number];
  return fixture.markdown.slice(start, Math.min(end, start + len));
}

describe("locateQuote", () => {
  it("finds exact quotes", () => {
    const quote = quoteFromBlock(0, 0);
    const range = locateQuote(fixture.markdown, quote);
    expect(range).not.toBeNull();
    expect(fixture.markdown.slice(range![0], range![1])).toBe(quote);
  });

  it("tolerates whitespace drift (newlines quoted as spaces)", () => {
    const quote = quoteFromBlock(0, 0, 120).replace(/\s+/g, " ");
    const range = locateQuote(fixture.markdown, quote);
    expect(range).not.toBeNull();
  });

  it("tolerates case drift as a last resort", () => {
    const quote = quoteFromBlock(0, 0).toLowerCase();
    expect(locateQuote(fixture.markdown, quote)).not.toBeNull();
  });

  it("returns null for text not in the document", () => {
    expect(locateQuote(fixture.markdown, "this sentence does not appear anywhere")).toBeNull();
    expect(locateQuote(fixture.markdown, "   ")).toBeNull();
  });
});

describe("groundCitations", () => {
  it("maps a quote to its block's page, bbox, and id", () => {
    // A quote from a known page-2 block must cite page 2.
    const page2Block = fixture.pages[1]!.blocks.find(b => b.markdown_span);
    expect(page2Block).toBeDefined();
    const quote = fixture.markdown.slice(page2Block!.markdown_span![0], page2Block!.markdown_span![0] + 50);
    const result = groundCitations(fixture.markdown, fixture.pages, { field: [quote] });
    expect(result.field).toHaveLength(1);
    expect(result.field![0]!.page).toBe(2);
    expect(result.field![0]!.blockId).toBe(page2Block!.id);
    expect(result.field![0]!.bbox).toEqual(page2Block!.bbox);
    expect(result.field![0]!.text).toBe(quote);
  });

  it("returns one citation per overlapping block for boundary-crossing quotes", () => {
    // Build a quote spanning the end of one block and the start of the next
    // contiguous-span block.
    const spans = fixture.pages
      .flatMap(p => p.blocks.map(b => ({ page: p.page, b })))
      .filter(x => x.b.markdown_span)
      .sort((a, z) => a.b.markdown_span![0] - z.b.markdown_span![0]);
    const first = spans.find((x, i) => i + 1 < spans.length && spans[i + 1]!.b.markdown_span![0] - x.b.markdown_span![1] < 40);
    expect(first).toBeDefined();
    const idx = spans.indexOf(first!);
    const second = spans[idx + 1]!;
    const quote = fixture.markdown.slice(first!.b.markdown_span![1] - 30, second.b.markdown_span![0] + 30);
    const result = groundCitations(fixture.markdown, fixture.pages, { field: [quote] });
    const ids = result.field!.map(c => c.blockId);
    expect(ids).toContain(first!.b.id);
    expect(ids).toContain(second.b.id);
  });

  it("degrades unlocatable quotes to an empty citations array", () => {
    const result = groundCitations(fixture.markdown, fixture.pages, {
      revenue: ["a fabricated quote that is nowhere in the document"],
    });
    expect(result.revenue).toEqual([]);
  });

  it("dedupes multiple quotes landing in the same block", () => {
    const q1 = quoteFromBlock(0, 0, 40);
    const q2 = quoteFromBlock(0, 0, 80);
    const result = groundCitations(fixture.markdown, fixture.pages, { field: [q1, q2] });
    const ids = result.field!.map(c => c.blockId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("handles empty inputs", () => {
    expect(groundCitations(fixture.markdown, fixture.pages, {})).toEqual({});
    expect(groundCitations(fixture.markdown, [], { f: ["anything"] }).f).toEqual([]);
  });
});

describe("wrapSchemaWithCitations / splitCitedExtraction", () => {
  it("wraps a user schema under data and adds the citations map", () => {
    const wrapped = wrapSchemaWithCitations({
      type: "object",
      properties: { total_revenue: { type: "string" } },
    }) as any;
    expect(wrapped.properties.data.properties.total_revenue.type).toBe("string");
    // OpenAI strict mode: no free-form maps, additionalProperties false.
    expect(wrapped.additionalProperties).toBe(false);
    expect(wrapped.properties.citations.type).toBe("array");
    expect(wrapped.properties.citations.items.additionalProperties).toBe(false);
    expect(wrapped.required).toEqual(["data", "citations"]);
  });

  it("splits a wrapped result and normalizes quote shapes", () => {
    const split = splitCitedExtraction({
      data: { total_revenue: "$391B" },
      citations: [
        { field: "total_revenue", quotes: "net sales of $391 billion" },
        { field: "fiscal_year", quotes: ["ended September 27, 2025", 42 as any] },
      ],
    });
    expect(split).not.toBeNull();
    expect((split!.data as any).total_revenue).toBe("$391B");
    expect(split!.quotesByField.total_revenue).toEqual(["net sales of $391 billion"]);
    expect(split!.quotesByField.fiscal_year).toEqual(["ended September 27, 2025"]);
  });

  it("returns null when the wrapper shape is missing (model ignored it)", () => {
    expect(splitCitedExtraction({ total_revenue: "$391B" })).toBeNull();
    expect(splitCitedExtraction(null)).toBeNull();
    expect(splitCitedExtraction("just a string")).toBeNull();
  });
});
