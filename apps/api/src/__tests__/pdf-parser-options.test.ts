import {
  getPDFBlocks,
  getPDFMode,
  getPDFPageMarkdown,
  getPDFPageMarkers,
  scrapeOptions,
  shouldParseImages,
  shouldParsePDF,
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

  it("reads the `pageMarkers` option", () => {
    expect(getPDFPageMarkers([{ type: "pdf", pageMarkers: true }])).toBe(true);
    expect(getPDFPageMarkers([{ type: "pdf", pageMarkers: false }])).toBe(
      false,
    );
    expect(getPDFPageMarkers([{ type: "pdf" }])).toBe(false);
    expect(getPDFPageMarkers(["pdf"])).toBe(false);
    expect(getPDFPageMarkers(undefined)).toBe(false);
  });

  it("keeps `pageMarkers` flowing through the alias-normalizing transform", () => {
    const parser = parsePdfParser({
      type: "pdf",
      pageMarkers: true,
      pageMarkdown: true,
    });
    expect(parser.pageMarkers).toBe(true);
    expect(parser.pages).toBe(true);
    expect(getPDFPageMarkers([parser as any])).toBe(true);
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

describe("image parser", () => {
  it("is on by default, like pdf", () => {
    expect(scrapeOptions.parse({}).parsers).toEqual(["pdf", "image"]);
    expect(shouldParseImages(undefined)).toBe(true);
    expect(shouldParseImages(["pdf", "image"])).toBe(true);
    expect(shouldParsePDF(["pdf", "image"])).toBe(true);
  });

  it("opts out with an explicit list that omits it", () => {
    expect(shouldParseImages([])).toBe(false);
    expect(shouldParseImages(["pdf"])).toBe(false);
    expect(shouldParseImages([{ type: "pdf", mode: "ocr" }])).toBe(false);
    expect(scrapeOptions.parse({ parsers: ["pdf"] }).parsers).toEqual(["pdf"]);
  });

  it("accepts the string and object forms", () => {
    expect(shouldParseImages(["image"])).toBe(true);
    expect(shouldParseImages([{ type: "image" }])).toBe(true);
    expect(shouldParseImages([{ type: "pdf", mode: "ocr" }, "image"])).toBe(
      true,
    );
    expect(
      scrapeOptions.parse({ parsers: ["pdf", { type: "image" }] }).parsers,
    ).toEqual(["pdf", { type: "image" }]);
  });

  it("leaves the pdf parser alone", () => {
    expect(shouldParsePDF(["image"])).toBe(false);
    expect(getPDFMode(["pdf", "image"])).toBe("auto");
    expect(getPDFMode([{ type: "image" }, { type: "pdf", mode: "ocr" }])).toBe(
      "ocr",
    );
  });

  it("rejects the plural and unknown options", () => {
    expect(scrapeOptions.safeParse({ parsers: ["images"] }).success).toBe(
      false,
    );
    expect(
      scrapeOptions.safeParse({ parsers: [{ type: "image", mode: "ocr" }] })
        .success,
    ).toBe(false);
  });
});
