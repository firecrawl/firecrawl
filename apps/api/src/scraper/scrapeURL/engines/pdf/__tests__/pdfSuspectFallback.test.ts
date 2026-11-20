import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPdf, processPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithParsePDF } from "../pdfParse";
import { scrapePDF } from "../index";

vi.mock("@mendable/firecrawl-rs", () => ({
  processPdf: vi.fn(),
  detectPdf: vi.fn(),
}));

vi.mock("../firePDF", async importOriginal => ({
  ...(await importOriginal<typeof import("../firePDF")>()),
  scrapePDFWithFirePDF: vi.fn(),
}));

vi.mock("../pdfParse", () => ({
  scrapePDFWithParsePDF: vi.fn(),
}));

vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

const mockedProcessPdf = vi.mocked(processPdf);
const mockedDetectPdf = vi.mocked(detectPdf);
const mockedFirePdf = vi.mocked(scrapePDFWithFirePDF);
const mockedPdfParse = vi.mocked(scrapePDFWithParsePDF);

const configKeys = [
  "PDF_RUST_EXTRACT_ENABLE",
  "FIRE_PDF_ENABLE",
  "FIRE_PDF_BASE_URL",
  "FIRE_PDF_PERCENT",
  "FIRE_PDF_ASYNC_PERCENT",
  "PARSE_PDF_ALWAYS_FIRE_PDF",
] as const;
const originalConfig = Object.fromEntries(
  configKeys.map(key => [key, config[key]]),
);

function setConfig(
  overrides: Partial<Record<(typeof configKeys)[number], unknown>>,
) {
  Object.assign(config as any, overrides);
}

const tempDirs: string[] = [];

async function makeMeta(internalOptions: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-suspect-fallback-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "doc.pdf");
  await writeFile(filePath, "%PDF-1.7\n%test\n");
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return {
    id: "01a00000-0000-7000-8000-000000000000",
    url: "https://parse.firecrawl.dev/uploads/doc.pdf",
    options: { parsers: ["pdf"] },
    logger,
    featureFlags: new Set(["pdf"]),
    pdfPrefetch: {
      filePath,
      url: "https://parse.firecrawl.dev/uploads/doc.pdf",
      status: 200,
      proxyUsed: "basic",
    },
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: { teamId: "team-test", ...internalOptions },
  } as any;
}

// The reported #5759 document: 46 pages, ~3,000 chars of repeated page
// header (~59 non-whitespace chars/page) — suspicious at the Rust stage,
// so it is kept as the fallback candidate and pdf-parse runs.
const sparseRustResult = {
  pdfType: "TextBased",
  confidence: 1,
  isComplex: false,
  pageCount: 46,
  markdown: "EDITAL CULTURAL\n".repeat(200).slice(0, 3096),
  title: null,
  pagesNeedingOcr: [],
  logs: [],
};

describe("scrapePDF suspected-incomplete pdf-parse fallback (#5759)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({
      PDF_RUST_EXTRACT_ENABLE: true,
      FIRE_PDF_ENABLE: true,
      FIRE_PDF_BASE_URL: "http://fire-pdf.test",
      FIRE_PDF_PERCENT: 0,
      FIRE_PDF_ASYNC_PERCENT: 0,
      PARSE_PDF_ALWAYS_FIRE_PDF: true,
    });
    mockedProcessPdf.mockResolvedValue(sparseRustResult as any);
    mockedDetectPdf.mockResolvedValue({
      pdfType: "TextBased",
      pageCount: 46,
      title: null,
      logs: [],
    } as any);
    mockedFirePdf.mockResolvedValue({
      markdown: "fire-pdf",
      html: "<p>fire-pdf</p>",
      pagesProcessed: 46,
    });
    mockedPdfParse.mockResolvedValue({
      markdown: "pdf-parse",
      html: "<p>pdf-parse</p>",
    });
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    );
  });

  afterAll(() => {
    Object.assign(config as any, originalConfig);
  });

  it("judges a capped pdf-parse result on the pages it processed, not the document total", async () => {
    // pdf-parse ran over 5 pages of a 46-page document and extracted 600
    // chars (120/page — dense for what was processed). Judged against the
    // declared total it looks sparse (13/page) and the earlier, poorer
    // Rust header text would win; judged on pages processed it is the
    // better extraction and must be kept.
    mockedPdfParse.mockResolvedValue({
      markdown: "p".repeat(600),
      html: "<p>dense prefix</p>",
      pagesProcessed: 5,
      pageCount: 46,
    });
    const meta = await makeMeta({});
    const result = await scrapePDF(meta);

    expect(result.markdown).toBe("p".repeat(600));
    expect(mockedFirePdf).not.toHaveBeenCalled();
    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
  });

  it("warns when pdf-parse is itself suspicious but is the richer result", async () => {
    // pdf-parse extracted more than the Rust fallback (4,000 chars vs
    // ~2,700) but is still sparse for 46 pages, so it is kept — and the
    // structured incomplete-extraction warning must still be emitted,
    // with the stage and the density reason.
    mockedPdfParse.mockResolvedValue({
      markdown: "q".repeat(4000),
      html: "<p>richer but sparse</p>",
      pagesProcessed: 46,
      pageCount: 46,
    });
    const meta = await makeMeta({});
    const result = await scrapePDF(meta);

    expect(result.markdown).toBe("q".repeat(4000));
    expect(meta.logger.warn).toHaveBeenCalledWith(
      "pdf-parse result suspected incomplete -- keeping richer pdf-parse extraction",
      expect.objectContaining({
        event: "pdf_extraction_suspected_incomplete",
        stage: "pdf-parse-fallback",
        reason: expect.stringContaining("low text density"),
      }),
    );
    expect(meta.logger.warn).not.toHaveBeenCalledWith(
      "pdf-parse result suspected incomplete -- using richer earlier extraction",
      expect.anything(),
    );
  });

  it("still warns once when the earlier extraction wins over pdf-parse", async () => {
    // pdf-parse extracted less than the Rust fallback (2,000 chars vs
    // ~2,700) and is sparse, so the earlier extraction wins — with exactly
    // one structured warning, as before.
    mockedPdfParse.mockResolvedValue({
      markdown: "r".repeat(2000),
      html: "<p>poorer and sparse</p>",
      pagesProcessed: 46,
      pageCount: 46,
    });
    const meta = await makeMeta({});
    const result = await scrapePDF(meta);

    expect(result.markdown).toBe(sparseRustResult.markdown);
    const switchWarns = (meta.logger.warn as any).mock.calls.filter(
      ([message]: [string]) =>
        message ===
        "pdf-parse result suspected incomplete -- using richer earlier extraction",
    );
    expect(switchWarns).toHaveLength(1);
    expect(switchWarns[0][1]).toMatchObject({
      event: "pdf_extraction_suspected_incomplete",
      stage: "pdf-parse-fallback",
      reason: expect.stringContaining("low text density"),
    });
  });
});
