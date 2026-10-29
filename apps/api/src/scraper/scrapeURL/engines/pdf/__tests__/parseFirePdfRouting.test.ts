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
  "MINERU_PERCENT",
  "RUNPOD_MU_API_KEY",
  "RUNPOD_MU_POD_ID",
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

async function makeMeta(
  internalOptions: Record<string, unknown>,
  parsers: unknown[] = ["pdf"],
) {
  const dir = await mkdtemp(path.join(tmpdir(), "parse-fire-pdf-"));
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
    options: { parsers },
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

const eligibleTextPdf = {
  pdfType: "TextBased",
  confidence: 0.99,
  isComplex: false,
  pageCount: 1,
  markdown: "direct extraction",
  title: null,
  pagesNeedingOcr: [],
  logs: [],
};

describe("PDF routing for /v2/parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({
      PDF_RUST_EXTRACT_ENABLE: true,
      FIRE_PDF_ENABLE: true,
      FIRE_PDF_BASE_URL: "http://fire-pdf.test",
      FIRE_PDF_PERCENT: 0,
      FIRE_PDF_ASYNC_PERCENT: 0,
      MINERU_PERCENT: 0,
      RUNPOD_MU_API_KEY: undefined,
      RUNPOD_MU_POD_ID: undefined,
      PARSE_PDF_ALWAYS_FIRE_PDF: true,
    });
    mockedProcessPdf.mockResolvedValue(eligibleTextPdf as any);
    mockedDetectPdf.mockResolvedValue({
      pdfType: "TextBased",
      pageCount: 1,
      title: null,
      logs: [],
    } as any);
    mockedFirePdf.mockResolvedValue({
      markdown: "fire-pdf",
      html: "<p>fire-pdf</p>",
      pagesProcessed: 1,
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

  it("sends a direct-extraction-eligible parse PDF to FirePDF regardless of FIRE_PDF_PERCENT", async () => {
    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("fire-pdf");
    expect(mockedProcessPdf).not.toHaveBeenCalled();
    expect(mockedDetectPdf).toHaveBeenCalledTimes(1);
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
  });

  it("keeps parse PDFs away from the MinerU diversion", async () => {
    setConfig({ MINERU_PERCENT: 100 });

    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("fire-pdf");
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
  });

  it("falls back to pdf-parse when FirePDF fails", async () => {
    mockedFirePdf.mockRejectedValueOnce(new Error("fire-pdf 503"));

    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
  });

  it("keeps direct extraction for scrape requests", async () => {
    setConfig({ FIRE_PDF_PERCENT: 100 });

    const result = await scrapePDF(await makeMeta({}));

    expect(result.markdown).toBe("direct extraction");
    expect(mockedProcessPdf).toHaveBeenCalledTimes(1);
    expect(mockedFirePdf).not.toHaveBeenCalled();
  });

  it("keeps direct extraction for parse in fast mode", async () => {
    const result = await scrapePDF(
      await makeMeta({ isParse: true }, [{ type: "pdf", mode: "fast" }]),
    );

    expect(result.markdown).toBe("direct extraction");
    expect(mockedFirePdf).not.toHaveBeenCalled();
  });

  it("restores direct extraction for parse when the flag is off", async () => {
    setConfig({ PARSE_PDF_ALWAYS_FIRE_PDF: false });

    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("direct extraction");
    expect(mockedFirePdf).not.toHaveBeenCalled();
  });

  it("keeps direct extraction for parse when FirePDF is not configured", async () => {
    setConfig({ FIRE_PDF_ENABLE: false, FIRE_PDF_BASE_URL: undefined });

    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("direct extraction");
    expect(mockedFirePdf).not.toHaveBeenCalled();
  });
});
