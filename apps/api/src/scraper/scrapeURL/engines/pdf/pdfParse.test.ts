import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  getText: vi.fn(),
  getInfo: vi.fn(),
  destroy: vi.fn(),
  PDFParse: vi.fn(),
}));

vi.mock("pdf-parse", () => ({ PDFParse: mocks.PDFParse }));

import {
  PDF_PARSE_MAX_DECLARED_PAGES,
  PDF_PARSE_MAX_PAGES,
  scrapePDFWithParsePDF,
} from "./pdfParse";

function meta(): any {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

let dir: string;
let filePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pdf-parse-test-"));
  filePath = join(dir, "doc.pdf");
  await writeFile(filePath, "%PDF-1.4\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.getText.mockReset();
  mocks.getText.mockResolvedValue({
    text: "hello",
    total: 3,
    pages: [{ num: 1, text: "hello" }],
  });
  mocks.getInfo.mockReset();
  mocks.getInfo.mockResolvedValue({ total: 3 });
  mocks.destroy.mockReset();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.PDFParse.mockReset();
  mocks.PDFParse.mockImplementation(function () {
    return {
      getText: mocks.getText,
      getInfo: mocks.getInfo,
      destroy: mocks.destroy,
    };
  });
});

describe("scrapePDFWithParsePDF", () => {
  it("passes the request's maxPages to pdf-parse", async () => {
    const result = await scrapePDFWithParsePDF(meta(), filePath, 7);

    expect(result.markdown).toBe("\n\nhello");
    expect(result.pagesProcessed).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(mocks.PDFParse).toHaveBeenCalledTimes(1);
    expect(mocks.PDFParse.mock.calls[0][0]).toEqual({
      data: expect.any(Uint8Array),
    });
    expect(mocks.getText).toHaveBeenCalledWith({ first: 7, pageJoiner: "" });
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("caps the page walk when the request sets no maxPages", async () => {
    await scrapePDFWithParsePDF(meta(), filePath);

    expect(mocks.getText).toHaveBeenCalledWith({
      first: PDF_PARSE_MAX_PAGES,
      pageJoiner: "",
    });
  });

  it("logs when the declared page count exceeds the cap", async () => {
    mocks.getInfo.mockResolvedValue({ total: 50_000 });
    mocks.getText.mockResolvedValue({
      text: "x",
      total: 50_000,
      pages: [{ num: 1, text: "x" }],
    });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.pagesProcessed).toBe(10);
    expect(result.pageCount).toBe(50_000);
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ numPages: 50_000, truncatedToPages: 10 }),
    );
  });

  it("rejects a document declaring more pages than the ceiling before extracting", async () => {
    mocks.getInfo.mockResolvedValue({
      total: PDF_PARSE_MAX_DECLARED_PAGES + 1,
    });
    const m = meta();

    await expect(scrapePDFWithParsePDF(m, filePath, 10)).rejects.toThrow(
      "exceeding the limit",
    );
    expect(mocks.getText).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(m.logger.error).toHaveBeenCalledWith(
      "pdfParse failed",
      expect.objectContaining({ error: expect.anything() }),
    );
  });

  it("does not report a truncation when the declared count fits the cap", async () => {
    mocks.getText.mockResolvedValue({
      text: "x",
      total: 3,
      pages: [{ num: 1, text: "x" }],
    });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.pagesProcessed).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.not.objectContaining({ truncatedToPages: expect.anything() }),
    );
  });

  it("keeps the readable pages when one page fails to extract", async () => {
    mocks.getInfo.mockResolvedValue({ total: 2 });
    mocks.getText.mockImplementation(async (params: any) => {
      if (params.first === 1 && params.last === 1) {
        return { text: "one", total: 2, pages: [{ num: 1, text: "one" }] };
      }
      throw new Error("page 2 is corrupt");
    });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.markdown).toBe("\n\none\n\n");
    expect(result.pagesProcessed).toBe(1);
    expect(result.pageCount).toBe(2);
    expect(m.logger.warn).toHaveBeenCalledWith(
      "pdfParse skipped a page that failed to extract",
      expect.objectContaining({ page: 2 }),
    );
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ skippedPages: 1 }),
    );
    expect(m.logger.error).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("fails instead of returning an empty document when every page fails", async () => {
    mocks.getInfo.mockResolvedValue({ total: 2 });
    mocks.getText.mockRejectedValue(new Error("page 2 is corrupt"));
    const m = meta();

    await expect(scrapePDFWithParsePDF(m, filePath, 10)).rejects.toThrow(
      "page 2 is corrupt",
    );
    expect(m.logger.error).toHaveBeenCalledWith(
      "pdfParse failed",
      expect.objectContaining({ error: expect.anything() }),
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("returns the extraction result when destroying the parser fails", async () => {
    mocks.destroy.mockRejectedValue(new Error("destroy failed"));
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.markdown).toBe("\n\nhello");
    expect(m.logger.warn).toHaveBeenCalledWith(
      "pdfParse failed to destroy the parser",
      expect.objectContaining({ error: expect.anything() }),
    );
    expect(m.logger.error).not.toHaveBeenCalled();
  });

  it("surfaces the extraction error when destroying the parser also fails", async () => {
    mocks.getText.mockRejectedValue(new Error("bad pdf"));
    mocks.getInfo.mockRejectedValue(new Error("no info"));
    mocks.destroy.mockRejectedValue(new Error("destroy failed"));
    const m = meta();

    await expect(scrapePDFWithParsePDF(m, filePath, 10)).rejects.toThrow(
      "no info",
    );
    expect(m.logger.error).toHaveBeenCalledWith(
      "pdfParse failed",
      expect.objectContaining({
        error: expect.objectContaining({ message: "no info" }),
      }),
    );
  });

  it("destroys the parser when extraction fails outright", async () => {
    mocks.getText.mockRejectedValue(new Error("bad pdf"));
    mocks.getInfo.mockRejectedValue(new Error("no info"));
    const m = meta();

    await expect(scrapePDFWithParsePDF(m, filePath, 10)).rejects.toThrow(
      "no info",
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(m.logger.error).toHaveBeenCalledWith(
      "pdfParse failed",
      expect.objectContaining({ error: expect.anything() }),
    );
  });

  it("does not attempt extraction when the page count cannot be read", async () => {
    mocks.getInfo.mockRejectedValue(new Error("no info"));
    const m = meta();

    await expect(scrapePDFWithParsePDF(m, filePath, 10)).rejects.toThrow(
      "no info",
    );
    expect(mocks.getText).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it("recovers every page across multiple ranges when bulk extraction fails", async () => {
    mocks.getInfo.mockResolvedValue({ total: 40 });
    mocks.getText.mockImplementation(async (params: any) => {
      if (params.last === undefined) {
        throw new Error("bulk failed");
      }
      const pages = [];
      for (let num = params.first; num <= params.last; num++) {
        pages.push({ num, text: `p${num}` });
      }
      return { text: "", total: 40, pages };
    });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 100);

    expect(result.markdown).toBe(
      Array.from({ length: 40 }, (_, i) => `\n\np${i + 1}`).join(""),
    );
    expect(result.pagesProcessed).toBe(40);
    expect(result.pageCount).toBe(40);
    // One bulk attempt plus one call per 32-page range.
    expect(mocks.getText).toHaveBeenCalledTimes(3);
    expect(m.logger.error).not.toHaveBeenCalled();
  });
});
