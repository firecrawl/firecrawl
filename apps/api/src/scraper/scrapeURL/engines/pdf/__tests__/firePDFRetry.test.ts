import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithFirePDFAsync } from "../fire-pdf/async";
import { decideFirePdfAsyncRoute } from "../fire-pdf/routing";
import { FirePdfAsyncFailure } from "../fire-pdf/utils";
import { FirePdfScrapeIdConflictError } from "../fire-pdf/submit";
import {
  FIRE_PDF_RETRY_MIN_REMAINING_MS,
  isTransientFirePdfFailure,
} from "../fire-pdf/retry";
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

vi.mock("../fire-pdf/async", async importOriginal => ({
  ...(await importOriginal<typeof import("../fire-pdf/async")>()),
  scrapePDFWithFirePDFAsync: vi.fn(),
}));

vi.mock("../fire-pdf/routing", async importOriginal => ({
  ...(await importOriginal<typeof import("../fire-pdf/routing")>()),
  decideFirePdfAsyncRoute: vi.fn(),
}));

vi.mock("../pdfParse", () => ({
  scrapePDFWithParsePDF: vi.fn(),
}));

vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

const mockedDetectPdf = vi.mocked(detectPdf);
const mockedSync = vi.mocked(scrapePDFWithFirePDF);
const mockedAsync = vi.mocked(scrapePDFWithFirePDFAsync);
const mockedRoute = vi.mocked(decideFirePdfAsyncRoute);
const mockedPdfParse = vi.mocked(scrapePDFWithParsePDF);

const configKeys = [
  "PDF_RUST_EXTRACT_ENABLE",
  "FIRE_PDF_ENABLE",
  "FIRE_PDF_BASE_URL",
  "PARSE_PDF_ALWAYS_FIRE_PDF",
] as const;
const originalConfig = Object.fromEntries(
  configKeys.map(key => [key, config[key]]),
);

const tempDirs: string[] = [];

async function makeMeta(remainingMs = 60_000, parsers: unknown[] = ["pdf"]) {
  const dir = await mkdtemp(path.join(tmpdir(), "fire-pdf-retry-"));
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
      scrapeTimeout: vi.fn(() => remainingMs),
    },
    internalOptions: { teamId: "team-test", isParse: true },
  } as any;
}

function statusError(status: number) {
  return new Error("Request sent failure status", {
    cause: { response: { status, body: "{}" } },
  });
}

const firePdfResult = {
  markdown: "fire-pdf",
  html: "<p>fire-pdf</p>",
  pagesProcessed: 1,
};

describe("isTransientFirePdfFailure", () => {
  it.each([
    ["sync 503", statusError(503), true],
    ["sync 502", statusError(502), true],
    ["sync 429", statusError(429), true],
    ["sync 400", statusError(400), false],
    ["sync network failure", new Error("Request failed"), true],
    ["async http_503", new FirePdfAsyncFailure("http_503"), true],
    ["async network_error", new FirePdfAsyncFailure("network_error"), true],
    [
      "async 5xx status",
      new FirePdfAsyncFailure("http_5xx", { status: 500 }),
      true,
    ],
    [
      "async unexpected 4xx",
      new FirePdfAsyncFailure("http_5xx", { status: 404 }),
      false,
    ],
    [
      "async response validation failure",
      new FirePdfAsyncFailure("http_5xx", { error: "invalid body" }),
      false,
    ],
    [
      "async deadline_too_close",
      new FirePdfAsyncFailure("deadline_too_close"),
      true,
    ],
    ["async http_413", new FirePdfAsyncFailure("http_413"), false],
    [
      "job failed on OCR",
      new FirePdfAsyncFailure("terminal_failed", {
        errorClass: "all_pages_failed",
      }),
      true,
    ],
    [
      "job failed on a deadline",
      new FirePdfAsyncFailure("terminal_failed", {
        body: { error_class: "deadline_exceeded_triage" },
      }),
      true,
    ],
    [
      "job failed on a page-less document",
      new FirePdfAsyncFailure("terminal_failed", {
        errorClass: "pdf_no_pages",
      }),
      false,
    ],
    [
      "job failed without a class",
      new FirePdfAsyncFailure("terminal_failed"),
      false,
    ],
    ["scrape_id conflict", new FirePdfScrapeIdConflictError(), true],
    [
      "validation error",
      new Error("FirePDF response did not include pages"),
      false,
    ],
  ])("%s", (_, error, expected) => {
    expect(isTransientFirePdfFailure(error)).toBe(expected);
  });
});

describe("FirePDF retry in scrapePDF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(config as any, {
      PDF_RUST_EXTRACT_ENABLE: true,
      FIRE_PDF_ENABLE: true,
      FIRE_PDF_BASE_URL: "http://fire-pdf.test",
      PARSE_PDF_ALWAYS_FIRE_PDF: true,
    });
    mockedDetectPdf.mockResolvedValue({
      pdfType: "Scanned",
      pageCount: 1,
      title: null,
      logs: [],
    } as any);
    mockedRoute.mockReturnValue({
      enabled: false,
      reason: "outside_percentage",
    } as any);
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

  it("retries a transient sync failure once and serves the retry", async () => {
    mockedSync
      .mockRejectedValueOnce(statusError(503))
      .mockResolvedValueOnce(firePdfResult);

    const result = await scrapePDF(await makeMeta());

    expect(result.markdown).toBe("fire-pdf");
    expect(mockedSync).toHaveBeenCalledTimes(2);
    expect(mockedPdfParse).not.toHaveBeenCalled();
  });

  it("falls back to pdf-parse when the retry fails too", async () => {
    mockedSync
      .mockRejectedValueOnce(statusError(503))
      .mockRejectedValueOnce(statusError(503));

    const result = await scrapePDF(await makeMeta());

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedSync).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure caused by the document", async () => {
    mockedSync.mockRejectedValueOnce(statusError(400));

    const result = await scrapePDF(await makeMeta());

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the remaining scrape time is too short", async () => {
    mockedSync.mockRejectedValueOnce(statusError(503));

    const result = await scrapePDF(
      await makeMeta(FIRE_PDF_RETRY_MIN_REMAINING_MS - 1),
    );

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it("retries an async scrape_id conflict on the sync endpoint", async () => {
    mockedRoute.mockReturnValue({ enabled: true, reason: "percentage" } as any);
    mockedAsync.mockRejectedValueOnce(new FirePdfScrapeIdConflictError());
    mockedSync.mockResolvedValueOnce(firePdfResult);

    const result = await scrapePDF(await makeMeta());

    expect(result.markdown).toBe("fire-pdf");
    expect(mockedAsync).toHaveBeenCalledTimes(1);
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });

  it("does not retry twice when page-aware async already fell back to sync", async () => {
    mockedRoute.mockReturnValue({ enabled: true, reason: "percentage" } as any);
    mockedAsync.mockRejectedValueOnce(new FirePdfAsyncFailure("http_503"));
    mockedSync.mockRejectedValueOnce(statusError(503));

    await expect(
      scrapePDF(await makeMeta(60_000, [{ type: "pdf", blocks: true }])),
    ).rejects.toThrow("Request sent failure status");
    expect(mockedSync).toHaveBeenCalledTimes(1);
  });
});
