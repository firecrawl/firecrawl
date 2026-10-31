import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  pdfParse: vi.fn(),
}));

vi.mock("pdf-parse", () => ({ default: mocks.pdfParse }));

import {
  PDF_PARSE_MAX_PAGES,
  reconcilePageCountWithPdfParse,
  scrapePDFWithParsePDF,
} from "./pdfParse";

function meta(): any {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
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
  mocks.pdfParse.mockReset();
  mocks.pdfParse.mockResolvedValue({ text: "hello", numpages: 3 });
});

describe("scrapePDFWithParsePDF", () => {
  it("passes the request's maxPages to pdf-parse", async () => {
    const result = await scrapePDFWithParsePDF(meta(), filePath, 7);

    expect(result.markdown).toBe("hello");
    expect(result.pagesProcessed).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(mocks.pdfParse).toHaveBeenCalledTimes(1);
    expect(mocks.pdfParse.mock.calls[0][1]).toEqual({ max: 7 });
  });

  it("caps the page walk when the request sets no maxPages", async () => {
    await scrapePDFWithParsePDF(meta(), filePath);

    expect(mocks.pdfParse.mock.calls[0][1]).toEqual({
      max: PDF_PARSE_MAX_PAGES,
    });
  });

  it("logs when the declared page count exceeds the cap", async () => {
    mocks.pdfParse.mockResolvedValue({ text: "x", numpages: 5_000_000 });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.pagesProcessed).toBe(10);
    expect(result.pageCount).toBe(5_000_000);
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ numPages: 5_000_000, truncatedToPages: 10 }),
    );
  });

  it("does not report a truncation when the declared count fits the cap", async () => {
    mocks.pdfParse.mockResolvedValue({ text: "x", numpages: 3 });
    const m = meta();

    const result = await scrapePDFWithParsePDF(m, filePath, 10);

    expect(result.pagesProcessed).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.not.objectContaining({ truncatedToPages: expect.anything() }),
    );
  });
});

describe("reconcilePageCountWithPdfParse", () => {
  it("keeps a failed native detection at 0, so billing stays at the base credit", () => {
    expect(reconcilePageCountWithPdfParse(0, { pagesProcessed: 1000 })).toBe(0);
  });

  it("lowers a native count that pdf-parse truncated at its cap", () => {
    expect(reconcilePageCountWithPdfParse(5000, { pagesProcessed: 1000 })).toBe(
      1000,
    );
  });

  it("keeps a native count within the cap", () => {
    expect(reconcilePageCountWithPdfParse(300, { pagesProcessed: 300 })).toBe(
      300,
    );
    expect(reconcilePageCountWithPdfParse(7, { pagesProcessed: 10 })).toBe(7);
  });

  it("never raises the count", () => {
    expect(reconcilePageCountWithPdfParse(0, { pagesProcessed: 3 })).toBe(0);
    expect(reconcilePageCountWithPdfParse(2, { pagesProcessed: 9 })).toBe(2);
  });

  it("leaves the count alone when pdf-parse reports nothing", () => {
    expect(
      reconcilePageCountWithPdfParse(7, { pagesProcessed: undefined }),
    ).toBe(7);
    expect(reconcilePageCountWithPdfParse(7, null)).toBe(7);
  });
});
