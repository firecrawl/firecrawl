import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPdf, processPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithParsePDF } from "../pdfParse";
import { scrapePDF } from "../index";
import { AbortManager } from "../../../lib/abortManager";
import { pdfExtractionSemaphore } from "../semaphore";

vi.mock("@mendable/firecrawl-rs", () => ({
  processPdf: vi.fn(),
  detectPdf: vi.fn(),
}));

// These routing tests use prefetched files and replace all remote PDF backends.
// Avoid initializing the unused DNS cache while importing FirePDF's helpers.
vi.mock("../../../lib/cacheableLookup", () => ({
  cacheableLookup: { lookup: vi.fn(), install: vi.fn() },
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

const scannedPdf = {
  ...eligibleTextPdf,
  pdfType: "Scanned",
  confidence: 0.2,
  markdown: "",
  pagesNeedingOcr: [1],
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

  it("falls back to pdf-parse when FirePDF fails", async () => {
    mockedFirePdf.mockRejectedValueOnce(new Error("fire-pdf 503"));

    const result = await scrapePDF(await makeMeta({ isParse: true }));

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
  });

  it("falls back to pdf-parse when FirePDF fails on a scrape request", async () => {
    setConfig({ FIRE_PDF_PERCENT: 100 });
    mockedProcessPdf.mockResolvedValue(scannedPdf as any);
    mockedFirePdf.mockRejectedValueOnce(new Error("fire-pdf 503"));

    const result = await scrapePDF(await makeMeta({}));

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedFirePdf).toHaveBeenCalledTimes(1);
    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
  });

  it("uses pdf-parse for a scrape request outside the FirePDF sample", async () => {
    mockedProcessPdf.mockResolvedValue(scannedPdf as any);

    const result = await scrapePDF(await makeMeta({}));

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedFirePdf).not.toHaveBeenCalled();
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

  it.each(["fast", "ocr"])(
    "cancels queued %s work without starting extraction or fallback",
    async mode => {
      const meta = await makeMeta({}, [{ type: "pdf", mode }]);
      const controller = new AbortController();
      const reason = new Error("scrape deadline expired while queued");
      meta.abort = new AbortManager({
        signal: controller.signal,
        tier: "scrape",
        throwable: () => reason,
      });
      const releases = await Promise.all(
        Array.from({ length: config.PDF_EXTRACTION_CONCURRENCY }, () =>
          pdfExtractionSemaphore.acquire(),
        ),
      );
      let outcome: { result?: unknown; error?: unknown } | undefined;
      const operation = scrapePDF(meta).then(
        result => {
          outcome = { result };
        },
        error => {
          outcome = { error };
        },
      );

      try {
        const { register } = await import("prom-client");
        await vi.waitFor(async () => {
          expect(
            await register.getSingleMetricAsString(
              "pdf_extraction_semaphore_waiting",
            ),
          ).toContain("pdf_extraction_semaphore_waiting 1");
        });
        controller.abort();
        await vi.waitFor(() => expect(outcome).toBeDefined());
        expect(outcome).toMatchObject({
          error: { tier: "scrape", inner: reason },
        });
        expect(mockedProcessPdf).not.toHaveBeenCalled();
        expect(mockedDetectPdf).not.toHaveBeenCalled();
        expect(mockedFirePdf).not.toHaveBeenCalled();
        expect(mockedPdfParse).not.toHaveBeenCalled();
        await expect(stat(meta.pdfPrefetch.filePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        releases.forEach(release => release());
        await operation;
        meta.abort.dispose();
      }
    },
  );

  it.each(["fast", "ocr"])(
    "does not queue already cancelled %s work",
    async mode => {
      const meta = await makeMeta({}, [{ type: "pdf", mode }]);
      const controller = new AbortController();
      const reason = new Error("already cancelled");
      meta.abort = new AbortManager({
        signal: controller.signal,
        tier: "external",
        throwable: () => reason,
      });
      controller.abort();
      try {
        await expect(scrapePDF(meta)).rejects.toMatchObject({
          tier: "external",
          inner: reason,
        });
        expect(mockedProcessPdf).not.toHaveBeenCalled();
        expect(mockedDetectPdf).not.toHaveBeenCalled();
        expect(mockedFirePdf).not.toHaveBeenCalled();
        expect(mockedPdfParse).not.toHaveBeenCalled();
      } finally {
        meta.abort.dispose();
      }
    },
  );
});
