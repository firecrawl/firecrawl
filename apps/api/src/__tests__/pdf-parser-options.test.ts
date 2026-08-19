import { getPDFBlocks, getPDFPageMarkdown } from "../controllers/v2/types";

describe("PDF parser option getters", () => {
  it("reads the public `pages` option", () => {
    expect(getPDFPageMarkdown([{ type: "pdf", pages: true }])).toBe(true);
    expect(getPDFPageMarkdown([{ type: "pdf", pages: false }])).toBe(false);
    expect(getPDFPageMarkdown([{ type: "pdf" }])).toBe(false);
    expect(getPDFPageMarkdown(["pdf"])).toBe(false);
    expect(getPDFPageMarkdown(undefined)).toBe(false);
  });

  it("accepts the deprecated `pageMarkdown` alias", () => {
    expect(getPDFPageMarkdown([{ type: "pdf", pageMarkdown: true }])).toBe(
      true,
    );
  });

  it("prefers `pages` when both names are set", () => {
    expect(
      getPDFPageMarkdown([{ type: "pdf", pages: false, pageMarkdown: true }]),
    ).toBe(false);
    expect(
      getPDFPageMarkdown([{ type: "pdf", pages: true, pageMarkdown: false }]),
    ).toBe(true);
  });

  it("reads the `blocks` option", () => {
    expect(getPDFBlocks([{ type: "pdf", blocks: true }])).toBe(true);
    expect(getPDFBlocks([{ type: "pdf" }])).toBe(false);
    expect(getPDFBlocks(undefined)).toBe(false);
  });
});
