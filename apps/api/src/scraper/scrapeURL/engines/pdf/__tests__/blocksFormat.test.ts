import {
  scrapeOptions,
  getPDFTableFormat,
  type PDFBlock,
} from "../../../../../controllers/v2/types";
import { resultResponseSchema } from "../fire-pdf/schema";

describe("blocks format schema", () => {
  it("accepts blocks as a string-shorthand format", () => {
    const parsed = scrapeOptions.parse({ formats: ["markdown", "blocks"] });
    expect(parsed.formats).toContainEqual({ type: "blocks" });
  });

  it("accepts blocks as an object format", () => {
    const parsed = scrapeOptions.parse({ formats: [{ type: "blocks" }] });
    expect(parsed.formats).toContainEqual({ type: "blocks" });
  });

  it("accepts tableFormat on the pdf parser", () => {
    const parsed = scrapeOptions.parse({
      parsers: [{ type: "pdf", tableFormat: "dynamic" }],
    });
    expect(getPDFTableFormat(parsed.parsers)).toBe("dynamic");
  });

  it("rejects unknown tableFormat values", () => {
    expect(() =>
      scrapeOptions.parse({
        parsers: [{ type: "pdf", tableFormat: "csv" }],
      }),
    ).toThrow();
  });

  it("getPDFTableFormat returns undefined for bare pdf parser", () => {
    expect(getPDFTableFormat(["pdf"] as any)).toBeUndefined();
    expect(getPDFTableFormat(undefined)).toBeUndefined();
  });
});

describe("fire-pdf result schema (async)", () => {
  const v1 = {
    schema_version: 1,
    markdown: "# hi",
    pages_processed: 2,
    failed_pages: null,
    partial_pages: null,
  };

  it("parses v1 results (no pages field)", () => {
    const parsed = resultResponseSchema.parse(v1);
    expect(parsed.pages).toBeUndefined();
  });

  it("parses v2 results with blocks pages, passing block fields through", () => {
    const block: PDFBlock & { some_future_field: string } = {
      id: "p1.b0",
      type: "title",
      label: "doc_title",
      bbox: [0.1, 0.05, 0.9, 0.09],
      content: "# T",
      markdown_span: [0, 3],
      reading_order: 0,
      source: "native_text",
      confidence: { layout: 0.97, ocr: null },
      some_future_field: "must survive",
    };
    const parsed = resultResponseSchema.parse({
      ...v1,
      schema_version: 2,
      pages: [
        {
          page: 1,
          width: 1700,
          height: 2200,
          status: "ok",
          blocks: [block],
        },
      ],
    });
    expect(parsed.pages).toHaveLength(1);
    const page = parsed.pages![0] as any;
    expect(page.blocks[0].some_future_field).toBe("must survive");
  });
});
