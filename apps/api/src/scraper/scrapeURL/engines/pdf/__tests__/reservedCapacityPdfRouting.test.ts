import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { processPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import {
  ReservedCapacityUnavailableError,
  UsOnlyUnavailableError,
} from "../../../error";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithParsePDF } from "../pdfParse";
import { scrapePDFWithRunPodMU } from "../runpodMU";
import { mineruDiverted } from "../fire-pdf/by-reference";
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

vi.mock("../runpodMU", () => ({
  scrapePDFWithRunPodMU: vi.fn(),
}));

vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

const mockedProcessPdf = vi.mocked(processPdf);
const mockedFirePdf = vi.mocked(scrapePDFWithFirePDF);
const mockedPdfParse = vi.mocked(scrapePDFWithParsePDF);
const mockedRunPodMU = vi.mocked(scrapePDFWithRunPodMU);

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

async function makeMeta(teamFlags?: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "reserved-capacity-pdf-"));
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
    id: "01a00000-0000-7000-8000-000000000001",
    url: "https://example.com/doc.pdf",
    options: { parsers: ["pdf"] },
    logger,
    featureFlags: new Set(["pdf"]),
    pdfPrefetch: {
      filePath,
      url: "https://example.com/doc.pdf",
      status: 200,
      proxyUsed: "basic",
    },
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: {
      teamId: "team-test",
      ...(teamFlags && { teamFlags }),
    },
  } as any;
}

function nativeResult(pdfType: string, markdown: string) {
  return {
    pdfType,
    confidence: 0.99,
    isComplex: true,
    pageCount: 1,
    markdown,
    title: null,
    pagesNeedingOcr: [],
    logs: [],
  } as any;
}

const reserved = { reservedCapacity: true };

describe("PDF routing for teams restricted to reserved capacity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({
      PDF_RUST_EXTRACT_ENABLE: true,
      FIRE_PDF_ENABLE: true,
      FIRE_PDF_BASE_URL: "http://fire-pdf.test",
      FIRE_PDF_PERCENT: 100,
      FIRE_PDF_ASYNC_PERCENT: 0,
      MINERU_PERCENT: 0,
      RUNPOD_MU_API_KEY: "test-key",
      RUNPOD_MU_POD_ID: "test-endpoint",
      PARSE_PDF_ALWAYS_FIRE_PDF: false,
    });
    mockedProcessPdf.mockResolvedValue(nativeResult("TextBased", "text layer"));
    mockedFirePdf.mockResolvedValue({
      markdown: "fire-pdf",
      html: "<p>fire-pdf</p>",
      pagesProcessed: 1,
    });
    mockedPdfParse.mockResolvedValue({
      markdown: "pdf-parse",
      html: "<p>pdf-parse</p>",
    });
    mockedRunPodMU.mockResolvedValue({
      markdown: "alternate",
      html: "<p>alternate</p>",
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

  it("never diverts a restricted team to the alternate PDF engine", async () => {
    setConfig({ MINERU_PERCENT: 100 });

    expect(mineruDiverted(await makeMeta())).toBe(true);
    expect(mineruDiverted(await makeMeta(reserved))).toBe(false);

    const result = await scrapePDF(await makeMeta(reserved));

    expect(result.markdown).toBe("fire-pdf");
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
    expect(mockedRunPodMU).not.toHaveBeenCalled();
  });

  it("sends a restricted PDF to the PDF service regardless of FIRE_PDF_PERCENT", async () => {
    setConfig({ FIRE_PDF_PERCENT: 0, RUNPOD_MU_API_KEY: undefined });

    expect((await scrapePDF(await makeMeta())).markdown).toBe("pdf-parse");
    expect(mockedFirePdf).not.toHaveBeenCalled();

    expect((await scrapePDF(await makeMeta(reserved))).markdown).toBe(
      "fire-pdf",
    );
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
  });

  it("fails a restricted scrape the PDF service refuses, with no fallback", async () => {
    mockedFirePdf.mockRejectedValueOnce(
      new ReservedCapacityUnavailableError("no reserved capacity"),
    );

    const error = await scrapePDF(await makeMeta(reserved)).catch(e => e);

    expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
    expect(mockedRunPodMU).not.toHaveBeenCalled();
    expect(mockedPdfParse).not.toHaveBeenCalled();
  });

  it("skips the alternate engine fallback but keeps the local pdf-parse fallback for a restricted team", async () => {
    mockedFirePdf.mockRejectedValue(new Error("fire-pdf 500"));

    expect((await scrapePDF(await makeMeta())).markdown).toBe("alternate");
    expect(mockedRunPodMU).toHaveBeenCalledTimes(1);

    mockedRunPodMU.mockClear();
    expect((await scrapePDF(await makeMeta(reserved))).markdown).toBe(
      "pdf-parse",
    );
    expect(mockedRunPodMU).not.toHaveBeenCalled();
  });

  it.each([
    ["a scanned PDF", "Scanned", "page header"],
    ["a PDF with no text layer", "Mixed", "   "],
  ])(
    "refuses %s for a restricted team instead of returning it without OCR",
    async (_name, pdfType, text) => {
      mockedProcessPdf.mockResolvedValue(nativeResult(pdfType, ""));
      mockedFirePdf.mockRejectedValue(new Error("fire-pdf 500"));
      mockedPdfParse.mockResolvedValue({ markdown: text, html: text });

      const error = await scrapePDF(await makeMeta(reserved)).catch(e => e);

      expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
      expect(error.message).toContain(
        "PDF processing is unavailable for this team's configuration. Please retry later.",
      );
      expect(mockedRunPodMU).not.toHaveBeenCalled();
    },
  );

  it("keeps the US-only OCR error for a team with both restrictions", async () => {
    mockedProcessPdf.mockResolvedValue(nativeResult("Scanned", ""));
    mockedFirePdf.mockRejectedValue(new Error("fire-pdf 500"));
    mockedPdfParse.mockResolvedValue({ markdown: "", html: "" });

    const error = await scrapePDF(
      await makeMeta({ usOnly: true, reservedCapacity: true }),
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(mockedRunPodMU).not.toHaveBeenCalled();
  });
});
