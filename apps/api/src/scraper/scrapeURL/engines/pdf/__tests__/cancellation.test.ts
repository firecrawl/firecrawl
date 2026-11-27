import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectPdf, processPdf } from "@mendable/firecrawl-rs";
import { config } from "../../../../../config";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { PDFOCRRequiredError } from "../../../error";
import { AbortManager } from "../../../lib/abortManager";
import { scrapePDF } from "../index";
import { scrapePDFWithParsePDF } from "../pdfParse";
import { pdfExtractionSemaphore } from "../semaphore";

vi.mock("@mendable/firecrawl-rs", () => ({
  processPdf: vi.fn(),
  detectPdf: vi.fn(),
}));

vi.mock("../pdfParse", () => ({
  scrapePDFWithParsePDF: vi.fn(),
}));

vi.mock("../markdownToHtml", () => ({
  safeMarkdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`),
}));

const mockedProcessPdf = vi.mocked(processPdf);
const mockedDetectPdf = vi.mocked(detectPdf);
const mockedPdfParse = vi.mocked(scrapePDFWithParsePDF);
const originalRustEnabled = config.PDF_RUST_EXTRACT_ENABLE;
const tempDirs: string[] = [];
const abortManagers: AbortManager[] = [];

async function makeMeta(mode: PDFMode = "auto") {
  const dir = await mkdtemp(path.join(tmpdir(), "local-pdf-cancellation-"));
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
  const abort = new AbortManager();
  abortManagers.push(abort);
  return {
    id: "01a00000-0000-7000-8000-000000000000",
    url: "https://example.com/doc.pdf",
    options: { parsers: [{ type: "pdf", mode }] },
    logger,
    featureFlags: new Set(["pdf"]),
    pdfPrefetch: {
      filePath,
      url: "https://example.com/doc.pdf",
      status: 200,
      proxyUsed: "basic",
    },
    abort,
    internalOptions: { teamId: "team-test" },
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

const extractionPaths = [true, false].flatMap(rustEnabled =>
  (["fast", "auto"] as const).map(mode => ({
    operation: rustEnabled ? "processPdf" : "detectPdf",
    rustEnabled,
    mode,
  })),
);

describe("local PDF cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.PDF_RUST_EXTRACT_ENABLE = true;
    mockedProcessPdf.mockResolvedValue(eligibleTextPdf as any);
    mockedDetectPdf.mockResolvedValue({
      pdfType: "TextBased",
      pageCount: 1,
      title: null,
      logs: [],
    } as any);
    mockedPdfParse.mockResolvedValue({
      markdown: "pdf-parse",
      html: "<p>pdf-parse</p>",
    });
  });

  afterEach(async () => {
    config.PDF_RUST_EXTRACT_ENABLE = originalRustEnabled;
    abortManagers.splice(0).forEach(abort => abort.dispose());
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each(extractionPaths)(
    "cancels queued $operation in $mode mode without extraction or fallback",
    async ({ rustEnabled, mode }) => {
      config.PDF_RUST_EXTRACT_ENABLE = rustEnabled;
      const meta = await makeMeta(mode);
      const controller = new AbortController();
      const reason = new Error("scrape deadline expired while queued");
      meta.abort = new AbortManager({
        signal: controller.signal,
        tier: "scrape",
        throwable: () => reason,
      });
      abortManagers.push(meta.abort);
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
        expect(mockedPdfParse).not.toHaveBeenCalled();
        await expect(stat(meta.pdfPrefetch.filePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await register.getSingleMetricAsString(
            "pdf_extraction_semaphore_active",
          ),
        ).toContain(
          `pdf_extraction_semaphore_active ${config.PDF_EXTRACTION_CONCURRENCY}`,
        );
      } finally {
        releases.forEach(release => release());
        await operation;
      }
    },
  );

  it.each(extractionPaths)(
    "does not queue already cancelled $operation in $mode mode",
    async ({ rustEnabled, mode }) => {
      config.PDF_RUST_EXTRACT_ENABLE = rustEnabled;
      const meta = await makeMeta(mode);
      const controller = new AbortController();
      const reason = new Error("already cancelled");
      meta.abort = new AbortManager({
        signal: controller.signal,
        tier: "external",
        throwable: () => reason,
      });
      abortManagers.push(meta.abort);
      controller.abort();

      await expect(scrapePDF(meta)).rejects.toMatchObject({
        tier: "external",
        inner: reason,
      });
      expect(mockedProcessPdf).not.toHaveBeenCalled();
      expect(mockedDetectPdf).not.toHaveBeenCalled();
      expect(mockedPdfParse).not.toHaveBeenCalled();
      await expect(stat(meta.pdfPrefetch.filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("keeps eligible native extraction and cleans up its file", async () => {
    const meta = await makeMeta("fast");
    const result = await scrapePDF(meta);

    expect(result.markdown).toBe("direct extraction");
    expect(mockedProcessPdf).toHaveBeenCalledTimes(1);
    expect(mockedDetectPdf).not.toHaveBeenCalled();
    expect(mockedPdfParse).not.toHaveBeenCalled();
    await expect(stat(meta.pdfPrefetch.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps metadata detection followed by pdf-parse when Rust extraction is disabled", async () => {
    config.PDF_RUST_EXTRACT_ENABLE = false;
    const result = await scrapePDF(await makeMeta());

    expect(result.markdown).toBe("pdf-parse");
    expect(mockedDetectPdf).toHaveBeenCalledTimes(1);
    expect(mockedProcessPdf).not.toHaveBeenCalled();
    expect(mockedPdfParse).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "retains pdf-parse fallback for an ordinary native failure (Rust enabled: %s)",
    async rustEnabled => {
      config.PDF_RUST_EXTRACT_ENABLE = rustEnabled;
      const native = rustEnabled ? mockedProcessPdf : mockedDetectPdf;
      native.mockRejectedValueOnce(new Error("native extraction failed"));

      const result = await scrapePDF(await makeMeta());

      expect(result.markdown).toBe("pdf-parse");
      expect(native).toHaveBeenCalledTimes(1);
      expect(mockedPdfParse).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "preserves fast-mode OCR-required errors (Rust enabled: %s)",
    async rustEnabled => {
      config.PDF_RUST_EXTRACT_ENABLE = rustEnabled;
      const native = rustEnabled ? mockedProcessPdf : mockedDetectPdf;
      native.mockResolvedValueOnce({
        ...eligibleTextPdf,
        pdfType: "Scanned",
        confidence: 0.2,
        markdown: "",
        pagesNeedingOcr: [1],
      } as any);
      const meta = await makeMeta("fast");

      await expect(scrapePDF(meta)).rejects.toBeInstanceOf(PDFOCRRequiredError);
      expect(mockedPdfParse).not.toHaveBeenCalled();
      await expect(stat(meta.pdfPrefetch.filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
