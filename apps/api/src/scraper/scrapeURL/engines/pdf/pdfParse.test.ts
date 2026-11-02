import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  pdfParse: vi.fn(),
}));

vi.mock("pdf-parse", () => ({ default: mocks.pdfParse }));

import { PDF_PARSE_MAX_PAGES, scrapePDFWithParsePDF } from "./pdfParse";

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
    expect(m.logger.info).toHaveBeenCalledWith(
      "pdfParse succeeded",
      expect.objectContaining({ numPages: 5_000_000, truncatedToPages: 10 }),
    );
  });
});
