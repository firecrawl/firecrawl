import {
  getPDFBlocks,
  getPDFPageMarkdown,
  scrapeOptions,
} from "../controllers/v2/types";

function parsePdfParser(parser: Record<string, unknown>) {
  const parsed = scrapeOptions.parse({ parsers: [parser] });
  return parsed.parsers![0] as Record<string, unknown>;
}

describe("PDF parser option getters", () => {
  it("reads the public `pages` option", () => {
    expect(getPDFPageMarkdown([{ type: "pdf", pages: true }])).toBe(true);
    expect(getPDFPageMarkdown([{ type: "pdf", pages: false }])).toBe(false);
    expect(getPDFPageMarkdown([{ type: "pdf" }])).toBe(false);
    expect(getPDFPageMarkdown(["pdf"])).toBe(false);
    expect(getPDFPageMarkdown(undefined)).toBe(false);
  });

  it("reads the `blocks` option", () => {
    expect(getPDFBlocks([{ type: "pdf", blocks: true }])).toBe(true);
    expect(getPDFBlocks([{ type: "pdf" }])).toBe(false);
    expect(getPDFBlocks(undefined)).toBe(false);
  });
});

describe("deprecated pageMarkdown alias", () => {
  it("is folded into `pages` at the schema boundary", () => {
    const parser = parsePdfParser({ type: "pdf", pageMarkdown: true });
    expect(parser.pages).toBe(true);
    expect("pageMarkdown" in parser).toBe(false);
  });

  it("loses to an explicit `pages` when both are set", () => {
    expect(
      parsePdfParser({ type: "pdf", pages: false, pageMarkdown: true }).pages,
    ).toBe(false);
    expect(
      parsePdfParser({ type: "pdf", pages: true, pageMarkdown: false }).pages,
    ).toBe(true);
  });
});
