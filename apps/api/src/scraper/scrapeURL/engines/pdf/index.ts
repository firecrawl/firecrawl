import { Meta } from "../..";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { downloadFile, fetchFileToBuffer } from "../utils/downloadFile";
import { safeMarkdownToHtml } from "./markdownToHtml";
import {
  PDFAntibotError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  PDFPrefetchFailed,
  RemoveFeatureError,
  EngineUnsuccessfulError,
} from "../../error";
import { open, readFile, unlink } from "node:fs/promises";
import type { Response } from "undici";
import { AbortManagerThrownError } from "../../lib/abortManager";
import {
  shouldParsePDF,
  getPDFMaxPages,
  getPDFMode,
} from "../../../../controllers/v2/types";
import type { PDFMode } from "../../../../controllers/v2/types";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";
import { MAX_FILE_SIZE, MILLISECONDS_PER_PAGE } from "./types";
import type { PDFProcessorResult } from "./types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../lib/native-logging";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { scrapePDFWithRunPodMU } from "./runpodMU";
import { scrapePDFWithFirePDF } from "./firePDF";
import { scrapePDFWithParsePDF } from "./pdfParse";
import { captureExceptionWithZdrCheck } from "../../../../services/sentry";
import { isPdfBuffer, PDF_SNIFF_WINDOW } from "./pdfUtils";
import { comparePdfOutputs } from "./shadowComparison";

/** Check if the PDF is eligible for Rust extraction, returning a rejection reason or null. */
function getIneligibleReason(
  result: ReturnType<typeof processPdf>,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  if (!result.markdown?.length)
    return "empty markdown (unexpected for TextBased)";
  return null;
}

export async function scrapePDF(meta: Meta): Promise<EngineScrapeResult> {
  const shouldParse = shouldParsePDF(meta.options.parsers);
  const maxPages = getPDFMaxPages(meta.options.parsers);
  const mode: PDFMode = getPDFMode(meta.options.parsers);

  if (!shouldParse) {
    if (meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null) {
      const content = (await readFile(meta.pdfPrefetch.filePath)).toString(
        "base64",
      );
      return {
        url: meta.pdfPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        statusCode: meta.pdfPrefetch.status,

        html: content,
        markdown: content,

        contentType: "application/pdf",
        proxyUsed: meta.pdfPrefetch.proxyUsed,
      };
    } else {
      const file = await fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
      );

      if (!isPdfBuffer(file.buffer)) {
        // downloaded content isn't a valid PDF
        if (meta.pdfPrefetch === undefined) {
          // for non-PDF URLs, this is expected, not anti-bot
          if (!meta.featureFlags.has("pdf")) {
            throw new EngineUnsuccessfulError("pdf");
          } else {
            throw new PDFAntibotError();
          }
        } else {
          throw new PDFPrefetchFailed();
        }
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
  }

  const { response, tempFilePath } =
    meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null
      ? { response: meta.pdfPrefetch, tempFilePath: meta.pdfPrefetch.filePath }
      : await downloadFile(
          meta.id,
          meta.rewrittenUrl ?? meta.url,
          meta.options.skipTlsVerification,
          {
            headers: meta.options.headers,
            signal: meta.abort.asSignal(),
          },
        );

  try {
    // Validate the downloaded file is actually a PDF by checking magic bytes
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
      if (meta.pdfPrefetch === undefined) {
        if (!meta.featureFlags.has("pdf")) {
          throw new EngineUnsuccessfulError("pdf");
        } else {
          throw new PDFAntibotError();
        }
      } else {
        throw new PDFPrefetchFailed();
      }
    }

    let result: PDFProcessorResult | null = null;
    let effectivePageCount: number = 0;
    let metadataTitle: string | undefined;
    let rustMarkdownForShadow: string | undefined;
    let shadowPdfType: string | undefined;
    let shadowConfidence: number | undefined;
    let shadowIsComplex: boolean | undefined;
    let shadowIneligibleReason: string | null | undefined;
    let shadowPagesNeedingOcr: number[] | undefined;

    const forceFirePDF =
      !!meta.options.__forceFirePDF && !!config.FIRE_PDF_BASE_URL;
    const rustEnabled = !!config.PDF_RUST_EXTRACT_ENABLE;
    const logger = meta.logger.child({ method: "scrapePDF/processPdf" });

    // Route a percentage of traffic directly to MinerU, bypassing Rust extraction.
    // Forced Fire PDF takes precedence — don't divert those requests.
    const routeToMinerU =
      !forceFirePDF &&
      config.MINERU_PERCENT > 0 &&
      Math.random() * 100 < config.MINERU_PERCENT;

    if (routeToMinerU) {
      logger.info("Routing to MinerU via MINERU_PERCENT", {
        mineruPercent: config.MINERU_PERCENT,
        url: meta.rewrittenUrl ?? meta.url,
      });
    }

    if (!rustEnabled || mode === "ocr" || forceFirePDF || routeToMinerU) {
      // Legacy / OCR path: detect metadata only, skip Rust extraction.
      // When PDF_RUST_EXTRACT_ENABLE is off this is the only path taken,
      // matching current prod behaviour (detectPdf → MinerU → pdfParse).
      try {
        const nativeCtx = {
          scrapeId: meta.id,
          url: meta.rewrittenUrl ?? meta.url,
        };
        const startedAt = Date.now();
        const detection = await withSpan("native.pdf.detect", async span => {
          const result = detectPdf(tempFilePath, nativeCtx);
          setSpanAttributes(span, {
            "native.module": "pdf",
            "native.pdf_type": result.pdfType,
            "native.page_count": result.pageCount,
          });
          emitNativeLogs(result.logs, meta.logger, "pdf.detect");
          return result;
        });
        const durationMs = Date.now() - startedAt;

        logger.info("detectPdf completed", {
          durationMs,
          pdfType: detection.pdfType,
          pageCount: detection.pageCount,
          url: meta.rewrittenUrl ?? meta.url,
          rustEnabled,
          mode,
        });

        effectivePageCount = maxPages
          ? Math.min(detection.pageCount, maxPages)
          : detection.pageCount;
        metadataTitle = detection.title ?? undefined;
      } catch (error) {
        extractAndEmitNativeLogs(error, meta.logger, "pdf.detect");
        logger.warn("detectPdf failed", {
          error,
          url: meta.rewrittenUrl ?? meta.url,
        });
        captureExceptionWithZdrCheck(error, {
          extra: {
            zeroDataRetention: meta.internalOptions.zeroDataRetention ?? false,
            scrapeId: meta.id,
            teamId: meta.internalOptions.teamId,
            url: meta.rewrittenUrl ?? meta.url,
          },
        });
      }
    } else {
      // Rust extraction enabled (fast / auto modes).
      try {
        const nativeCtx = {
          scrapeId: meta.id,
          url: meta.rewrittenUrl ?? meta.url,
        };
        const startedAt = Date.now();
        const pdfResult = await withSpan("native.pdf.process", async span => {
          const result = processPdf(
            tempFilePath,
            maxPages ?? undefined,
            nativeCtx,
          );
          setSpanAttributes(span, {
            "native.module": "pdf",
            "native.pdf_type": result.pdfType,
            "native.page_count": result.pageCount,
            "native.confidence": result.confidence,
            "native.is_complex": result.isComplex,
          });
          emitNativeLogs(result.logs, meta.logger, "pdf.process");
          return result;
        });
        const durationMs = Date.now() - startedAt;

        logger.info("processPdf completed", {
          durationMs,
          pdfType: pdfResult.pdfType,
          pageCount: pdfResult.pageCount,
          confidence: pdfResult.confidence,
          isComplex: pdfResult.isComplex,
          markdownLength: pdfResult.markdown?.length ?? 0,
          url: meta.rewrittenUrl ?? meta.url,
          mode,
        });

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

        // Shadow-compare when Rust produced meaningful output but wasn't
        // eligible for direct serving. Includes:
        // - Ineligible TextBased (complex layouts, lower confidence)
        // - Mixed PDFs with substantial extracted text (invisible OCR layers)
        const charsPerPage =
          (pdfResult.markdown?.length ?? 0) / Math.max(pdfResult.pageCount, 1);
        const shadowEligible =
          !eligible &&
          pdfResult.markdown &&
          config.PDF_SHADOW_COMPARISON_ENABLE &&
          (pdfResult.pdfType === "TextBased" ||
            (pdfResult.pdfType === "Mixed" && charsPerPage >= 200));

        rustMarkdownForShadow = shadowEligible ? pdfResult.markdown : undefined;
        if (shadowEligible) {
          shadowPdfType = pdfResult.pdfType;
          shadowConfidence = pdfResult.confidence;
          shadowIsComplex = pdfResult.isComplex;
          shadowIneligibleReason = ineligibleReason;
          shadowPagesNeedingOcr = pdfResult.pagesNeedingOcr;
        }

        // In fast mode, if the PDF requires OCR, fail immediately with a
        // clear error instead of returning empty content.
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
        logger.warn("processPdf failed, falling back to MU/PdfParse", {
          error,
          url: meta.rewrittenUrl ?? meta.url,
        });
        captureExceptionWithZdrCheck(error, {
          extra: {
            zeroDataRetention: meta.internalOptions.zeroDataRetention ?? false,
            scrapeId: meta.id,
            teamId: meta.internalOptions.teamId,
            url: meta.rewrittenUrl ?? meta.url,
          },
        });
        // effectivePageCount stays 0 — skip time budget check
      }
    }

    // Only enforce the per-page time budget when we need MU/fallback.
    // Rust extraction is fast enough that the constraint doesn't apply.
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

    // OCR / MU fallback.
    // Skipped only when Rust extraction is enabled AND mode is "fast",
    // unless we explicitly routed to MinerU via MINERU_PERCENT.
    const skipOCR = rustEnabled && mode === "fast" && !routeToMinerU;
    if (!result && !skipOCR) {
      const base64Content = (await readFile(tempFilePath)).toString("base64");

      // Route a percentage of traffic to Fire PDF instead of MinerU.
      // forceFirePDF always wins; skip percentage-based Fire PDF when
      // we explicitly routed to MinerU via MINERU_PERCENT.
      const useFirePDF =
        forceFirePDF ||
        (!routeToMinerU &&
          config.FIRE_PDF_ENABLE &&
          config.FIRE_PDF_BASE_URL &&
          base64Content.length < MAX_FILE_SIZE &&
          Math.random() * 100 < config.FIRE_PDF_PERCENT);

      if (useFirePDF) {
        try {
          result = await scrapePDFWithFirePDF(
            {
              ...meta,
              logger: meta.logger.child({
                method: "scrapePDF/firePDF",
              }),
            },
            base64Content,
            maxPages,
            effectivePageCount,
          );
        } catch (error) {
          if (
            error instanceof RemoveFeatureError ||
            error instanceof AbortManagerThrownError
          ) {
            throw error;
          }
          if (forceFirePDF) {
            meta.logger.error("FirePDF failed (forced, no fallback)", {
              method: "scrapePDF/firePDF",
              error,
            });
            throw error;
          }
          meta.logger.warn("FirePDF failed -- falling back to MinerU", {
            method: "scrapePDF/firePDF",
            error,
          });
        }
      }

      if (
        !result &&
        !forceFirePDF &&
        base64Content.length < MAX_FILE_SIZE &&
        config.RUNPOD_MU_API_KEY &&
        config.RUNPOD_MU_POD_ID
      ) {
        const muV1StartedAt = Date.now();
        try {
          result = await scrapePDFWithRunPodMU(
            {
              ...meta,
              logger: meta.logger.child({
                method: "scrapePDF/scrapePDFWithRunPodMU",
              }),
            },
            tempFilePath,
            base64Content,
            maxPages,
            effectivePageCount,
          );
          const muV1DurationMs = Date.now() - muV1StartedAt;
          meta.logger
            .child({ method: "scrapePDF/MUv1Experiment" })
            .info("MU v1 completed", {
              durationMs: muV1DurationMs,
              url: meta.rewrittenUrl ?? meta.url,
              pages: effectivePageCount,
              success: true,
            });

          if (
            rustMarkdownForShadow &&
            result?.markdown &&
            config.PDF_SHADOW_COMPARISON_ENABLE
          ) {
            const shadowRust = rustMarkdownForShadow;
            const shadowMu = result.markdown;
            const shadowLogger = meta.logger.child({
              method: "scrapePDF/shadowComparison",
            });
            const isZdr = !!meta.internalOptions.zeroDataRetention;

            (async () => {
              try {
                const metrics = comparePdfOutputs(shadowRust, shadowMu);
                shadowLogger.info("shadow comparison complete", {
                  scrapeId: meta.id,
                  url: isZdr ? undefined : (meta.rewrittenUrl ?? meta.url),
                  pageCount: effectivePageCount,
                  pdfType: shadowPdfType,
                  confidence: shadowConfidence,
                  isComplex: shadowIsComplex,
                  ineligibleReason: shadowIneligibleReason,
                  ocrPageCount: shadowPagesNeedingOcr?.length ?? 0,
                  ocrPageRatio:
                    effectivePageCount > 0
                      ? Math.round(
                          ((shadowPagesNeedingOcr?.length ?? 0) * 100) /
                            effectivePageCount,
                        ) / 100
                      : 0,
                  ...metrics.overall,
                });
              } catch (error) {
                shadowLogger.warn("shadow comparison failed", { error });
              }
            })();
          }
        } catch (error) {
          if (
            error instanceof RemoveFeatureError ||
            error instanceof AbortManagerThrownError
          ) {
            throw error;
          }
          meta.logger.warn(
            "RunPod MU failed to parse PDF (could be due to timeout) -- falling back to parse-pdf",
            { error },
          );
          captureExceptionWithZdrCheck(error, {
            extra: {
              zeroDataRetention:
                meta.internalOptions.zeroDataRetention ?? false,
              scrapeId: meta.id,
              teamId: meta.internalOptions.teamId,
              url: meta.rewrittenUrl ?? meta.url,
            },
          });
          const muV1DurationMs = Date.now() - muV1StartedAt;
          meta.logger
            .child({ method: "scrapePDF/MUv1Experiment" })
            .info("MU v1 failed", {
              durationMs: muV1DurationMs,
              url: meta.rewrittenUrl ?? meta.url,
              pages: effectivePageCount,
              success: false,
            });
        }
      }
    }

    // Final fallback to PdfParse (skipped when Fire PDF is forced).
    if (!result && !forceFirePDF) {
      result = await scrapePDFWithParsePDF(
        {
          ...meta,
          logger: meta.logger.child({
            method: "scrapePDF/scrapePDFWithParsePDF",
          }),
        },
        tempFilePath,
      );
    }

    return {
      url: response.url ?? meta.rewrittenUrl ?? meta.url,
      statusCode: response.status,
      html: result?.html ?? "",
      markdown: result?.markdown ?? "",
      pdfMetadata: {
        numPages: effectivePageCount,
        title: metadataTitle,
      },

      contentType: "application/pdf",
      proxyUsed: "basic",
    };
  } finally {
    // Always clean up temp file after we're done with it
    try {
      await unlink(tempFilePath);
    } catch (error) {
      // Ignore errors when cleaning up temp files
      meta.logger?.warn("Failed to clean up temporary PDF file", {
        error,
        tempFilePath,
      });
    }
  }
}

export function pdfMaxReasonableTime(meta: Meta): number {
  return 120000; // Infinity, really
}
