import { Meta } from "../..";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import {
  downloadFile,
  fetchFileGuardingProxyFailure,
  fetchFileToBuffer,
} from "../utils/downloadFile";
import { safeMarkdownToHtml } from "./markdownToHtml";
import {
  PDFAntibotError,
  PDFFetchProxyError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  PDFPrefetchFailed,
  EngineUnsuccessfulError,
  UnsupportedFileError,
} from "../../error";
import { open, readFile, stat, unlink } from "node:fs/promises";
import {
  shouldParsePDF,
  getPDFMaxPages,
  getPDFMode,
} from "../../../../controllers/v2/types";
import type { PDFMode } from "../../../../controllers/v2/types";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";
import { MILLISECONDS_PER_PAGE, PDF_DOWNLOAD_MAX_FILE_SIZE } from "./types";
import type { PDFProcessorResult } from "./types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../lib/native-logging";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { hasFilePrefetchEngine } from "../utils/specialtyHandler";
import { scrapePDFWithParsePDF } from "./pdfParse";
import { reconcilePageCountWithPdfParse } from "./pageCount";
import { isPdfBuffer, PDF_SNIFF_WINDOW } from "./pdfUtils";
import { completeTruncatedHandoff } from "./truncatedHandoff";
import { withPdfExtractionPermit } from "./semaphore";

export {
  detectPdf,
  isPdfBuffer,
  PDF_SNIFF_WINDOW,
  processPdf,
  reconcilePageCountWithPdfParse,
  scrapePDFWithParsePDF,
  withPdfExtractionPermit,
};

/** Check if the PDF is eligible for Rust extraction, returning a rejection reason or null. */
export function getIneligibleReason(
  result: Awaited<ReturnType<typeof processPdf>>,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  if (!result.markdown?.length)
    return "empty markdown (unexpected for TextBased)";
  return null;
}

/**
 * Guards direct PDF downloads so a proxy tunneling failure converts into
 * PDFFetchProxyError for browser fallback recovery.
 */
export function fetchPdfFileGuardingProxyFailure<T>(
  meta: Meta,
  fetch: () => Promise<T>,
): Promise<T> {
  return fetchFileGuardingProxyFailure(
    {
      prefetch: meta.pdfPrefetch,
      flagMandated:
        (meta.internalOptions.forceEngine === undefined &&
          meta.featureFlags.has("pdf")) ||
        meta.internalOptions.forceEngine === "pdf",
      makeError: () => new PDFFetchProxyError(),
    },
    fetch,
  );
}

export async function scrapePDF(meta: Meta): Promise<EngineScrapeResult> {
  if (
    hasFilePrefetchEngine() &&
    meta.internalOptions.forceEngine === undefined &&
    meta.pdfPrefetch == null
  ) {
    if (
      meta.documentPrefetch != null ||
      meta.imagePrefetch != null ||
      !meta.featureFlags.has("pdf")
    ) {
      throw new EngineUnsuccessfulError("pdf");
    }
    throw new PDFAntibotError();
  }

  const shouldParse = shouldParsePDF(meta.options.parsers);
  const maxPages = getPDFMaxPages(meta.options.parsers);
  const mode: PDFMode = getPDFMode(meta.options.parsers);

  const prefetch =
    meta.pdfPrefetch != null
      ? await completeTruncatedHandoff(
          meta,
          meta.pdfPrefetch,
          PDF_DOWNLOAD_MAX_FILE_SIZE,
        )
      : meta.pdfPrefetch;

  if (!shouldParse) {
    if (prefetch !== undefined && prefetch !== null) {
      try {
        const prefetchSize = (await stat(prefetch.filePath)).size;
        if (prefetchSize > PDF_DOWNLOAD_MAX_FILE_SIZE) {
          throw new UnsupportedFileError("File exceeds size limit");
        }
        const content = (await readFile(prefetch.filePath)).toString("base64");
        return {
          url: prefetch.url ?? meta.rewrittenUrl ?? meta.url,
          statusCode: prefetch.status,
          html: content,
          markdown: content,
          contentType: "application/pdf",
          proxyUsed: prefetch.proxyUsed,
        };
      } finally {
        try {
          await unlink(prefetch.filePath);
        } catch (error) {
          meta.logger?.warn("Failed to clean up temporary PDF file", {
            error,
            tempFilePath: prefetch.filePath,
          });
        }
      }
    }

    const file = await fetchPdfFileGuardingProxyFailure(meta, () =>
      fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
        PDF_DOWNLOAD_MAX_FILE_SIZE,
      ),
    );

    if (!isPdfBuffer(file.buffer)) {
      if (meta.pdfPrefetch == null) {
        if (!meta.featureFlags.has("pdf")) {
          throw new EngineUnsuccessfulError("pdf");
        }
        throw new PDFAntibotError();
      }
      throw new PDFPrefetchFailed();
    }

    const content = file.buffer.toString("base64");
    return {
      url: file.response.url,
      statusCode: file.response.status,
      html: content,
      markdown: content,
      contentType: "application/pdf",
      proxyUsed: "basic",
    };
  }

  const { response, tempFilePath } =
    prefetch !== undefined && prefetch !== null
      ? { response: prefetch, tempFilePath: prefetch.filePath }
      : await fetchPdfFileGuardingProxyFailure(meta, () =>
          downloadFile(
            meta.id,
            meta.rewrittenUrl ?? meta.url,
            meta.options.skipTlsVerification,
            {
              headers: meta.options.headers,
              signal: meta.abort.asSignal(),
            },
            PDF_DOWNLOAD_MAX_FILE_SIZE,
          ),
        );

  try {
    const header = Buffer.alloc(PDF_SNIFF_WINDOW);
    const fh = await open(tempFilePath, "r");
    let headerBytesRead: number;
    try {
      ({ bytesRead: headerBytesRead } = await fh.read(
        header,
        0,
        PDF_SNIFF_WINDOW,
        0,
      ));
    } finally {
      await fh.close();
    }

    if (!isPdfBuffer(header.subarray(0, headerBytesRead))) {
      if (meta.pdfPrefetch == null) {
        if (!meta.featureFlags.has("pdf")) {
          throw new EngineUnsuccessfulError("pdf");
        }
        throw new PDFAntibotError();
      }
      throw new PDFPrefetchFailed();
    }

    let result: PDFProcessorResult | null = null;
    let effectivePageCount = 0;
    let totalPageCount: number | undefined;
    let metadataTitle: string | undefined;

    const rustEnabled = !!config.PDF_RUST_EXTRACT_ENABLE;
    const logger = meta.logger.child({ method: "scrapePDF/processPdf" });

    if (!rustEnabled) {
      try {
        const nativeCtx = {
          scrapeId: meta.id,
          url: meta.rewrittenUrl ?? meta.url,
        };
        const startedAt = Date.now();
        const detection = await withSpan("native.pdf.detect", async span => {
          const detected = await withPdfExtractionPermit(() =>
            detectPdf(tempFilePath, nativeCtx),
          );
          setSpanAttributes(span, {
            "native.module": "pdf",
            "native.pdf_type": detected.pdfType,
            "native.page_count": detected.pageCount,
          });
          emitNativeLogs(detected.logs, meta.logger, "pdf.detect");
          return detected;
        });

        logger.info("detectPdf completed", {
          durationMs: Date.now() - startedAt,
          pdfType: detection.pdfType,
          pageCount: detection.pageCount,
          url: meta.rewrittenUrl ?? meta.url,
          rustEnabled,
          mode,
        });

        totalPageCount = detection.pageCount;
        effectivePageCount = maxPages
          ? Math.min(detection.pageCount, maxPages)
          : detection.pageCount;
        metadataTitle = detection.title ?? undefined;

        if (
          mode === "fast" &&
          (detection.pdfType === "Scanned" ||
            detection.pdfType === "ImageBased")
        ) {
          throw new PDFOCRRequiredError(detection.pdfType);
        }
      } catch (error) {
        if (error instanceof PDFOCRRequiredError) {
          throw error;
        }
        extractAndEmitNativeLogs(error, meta.logger, "pdf.detect");
        logger.warn("detectPdf failed", {
          error,
          url: meta.rewrittenUrl ?? meta.url,
        });
      }
    } else {
      try {
        const nativeCtx = {
          scrapeId: meta.id,
          url: meta.rewrittenUrl ?? meta.url,
        };
        const startedAt = Date.now();
        const pdfResult = await withSpan("native.pdf.process", async span => {
          const processed = await withPdfExtractionPermit(() =>
            processPdf(tempFilePath, maxPages ?? undefined, nativeCtx),
          );
          setSpanAttributes(span, {
            "native.module": "pdf",
            "native.pdf_type": processed.pdfType,
            "native.page_count": processed.pageCount,
          });
          emitNativeLogs(processed.logs, meta.logger, "pdf.process");
          return processed;
        });

        logger.info("processPdf completed", {
          durationMs: Date.now() - startedAt,
          pdfType: pdfResult.pdfType,
          pageCount: pdfResult.pageCount,
          confidence: pdfResult.confidence,
          isComplex: pdfResult.isComplex,
          markdownLength: pdfResult.markdown?.length ?? 0,
          url: meta.rewrittenUrl ?? meta.url,
          mode,
        });

        totalPageCount = pdfResult.pageCount;
        effectivePageCount = maxPages
          ? Math.min(pdfResult.pageCount, maxPages)
          : pdfResult.pageCount;
        metadataTitle = pdfResult.title ?? undefined;

        const ineligibleReason = getIneligibleReason(pdfResult);
        const eligible = !ineligibleReason;

        logger.info("Rust PDF eligibility", {
          rust_pdf_eligible: eligible,
          reason: ineligibleReason ?? "eligible",
          url: meta.rewrittenUrl ?? meta.url,
          pdfType: pdfResult.pdfType,
          isComplex: pdfResult.isComplex,
          pageCount: pdfResult.pageCount,
          confidence: pdfResult.confidence,
          mode,
        });

        if (
          mode === "fast" &&
          (pdfResult.pdfType === "Scanned" ||
            pdfResult.pdfType === "ImageBased")
        ) {
          throw new PDFOCRRequiredError(pdfResult.pdfType);
        }

        if (eligible && pdfResult.markdown) {
          const html = await safeMarkdownToHtml(
            pdfResult.markdown,
            logger,
            meta.id,
          );
          result = { markdown: pdfResult.markdown, html };
        }
      } catch (error) {
        if (error instanceof PDFOCRRequiredError) {
          throw error;
        }
        extractAndEmitNativeLogs(error, meta.logger, "pdf.process");
        logger.warn("processPdf failed, falling back to PdfParse", {
          error,
          url: meta.rewrittenUrl ?? meta.url,
        });
      }
    }

    if (
      !result &&
      effectivePageCount > 0 &&
      effectivePageCount * MILLISECONDS_PER_PAGE >
        (meta.abort.scrapeTimeout() ?? Infinity)
    ) {
      throw new PDFInsufficientTimeError(
        effectivePageCount,
        effectivePageCount * MILLISECONDS_PER_PAGE + 5000,
      );
    }

    if (!result) {
      result = await scrapePDFWithParsePDF(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapePDF/scrapePDFWithParsePDF",
          }),
        },
        tempFilePath,
        maxPages ?? undefined,
      );
      effectivePageCount = reconcilePageCountWithPdfParse(
        effectivePageCount,
        result,
      );
      if (totalPageCount === undefined && result.pageCount !== undefined) {
        totalPageCount = result.pageCount;
      }
    }

    return {
      url: response.url ?? meta.rewrittenUrl ?? meta.url,
      statusCode: response.status,
      html: result?.html ?? "",
      markdown: result?.markdown ?? "",
      pdfMetadata: {
        numPages: effectivePageCount,
        totalPages: totalPageCount,
        title: metadataTitle,
      },
      contentType: "application/pdf",
      proxyUsed: prefetch?.proxyUsed ?? "basic",
    };
  } finally {
    try {
      await unlink(tempFilePath);
    } catch (error) {
      meta.logger?.warn("Failed to clean up temporary PDF file", {
        error,
        tempFilePath,
      });
    }
  }
}

export function pdfMaxReasonableTime(_meta: Meta): number {
  return 120000;
}
