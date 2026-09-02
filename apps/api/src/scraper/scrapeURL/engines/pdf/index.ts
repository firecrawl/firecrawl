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
  RemoveFeatureError,
  EngineUnsuccessfulError,
  UnsupportedFileError,
} from "../../error";
import { open, readFile, stat, unlink } from "node:fs/promises";
import type { Response } from "undici";
import { AbortManagerThrownError } from "../../lib/abortManager";
import {
  shouldParsePDF,
  getPDFMaxPages,
  getPDFMode,
  getPDFPageMarkdown,
  getPDFBlocks,
  getPDFPageMarkers,
  getFirePdfAsync,
} from "../../../../controllers/v2/types";
import type { PDFMode } from "../../../../controllers/v2/types";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";
import {
  FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
  FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE,
  FIRE_PDF_MAX_FILE_SIZE,
  MAX_FILE_SIZE,
  MILLISECONDS_PER_PAGE,
  PDF_DOWNLOAD_MAX_FILE_SIZE,
} from "./types";
import type { PDFProcessorResult } from "./types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../lib/native-logging";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { scrapePDFWithRunPodMU } from "./runpodMU";
import { useFireEngine } from "../fire-engine/available";
import { reconcilePageCountWithFirePdf, scrapePDFWithFirePDF } from "./firePDF";
import { scrapePDFWithFirePDFAsync } from "./fire-pdf/async";
import {
  byReferenceReachableForRequest,
  largePdfLimitBytes,
  mineruDiverted,
} from "./fire-pdf/by-reference";
import { runFirePdfByReferenceAttempt } from "./fire-pdf/by-reference-flow";
import { decideFirePdfAsyncRoute } from "./fire-pdf/routing";
import { scrapePDFWithParsePDF } from "./pdfParse";
import { toPublicBlocks } from "./blocks";
import { captureExceptionWithZdrCheck } from "../../../../services/sentry";
import { isPdfBuffer, PDF_SNIFF_WINDOW } from "./pdfUtils";
import { comparePdfOutputs } from "./shadowComparison";
import { withPdfExtractionPermit } from "./semaphore";

/** Check if the PDF is eligible for Rust extraction, returning a rejection reason or null. */
function getIneligibleReason(
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
 * Guards the pdf engine's direct undici downloads: a proxy tunneling
 * failure converts into PDFFetchProxyError, which the scrapeURL retry loop
 * handles exactly like PDFAntibotError (clear the "pdf" flag, re-run the
 * waterfall, browser engine fetches the file). See
 * fetchFileGuardingProxyFailure for the conversion eligibility rules.
 */
function fetchPdfFileGuardingProxyFailure<T>(
  meta: Meta,
  fetch: () => Promise<T>,
): Promise<T> {
  return fetchFileGuardingProxyFailure(
    {
      prefetch: meta.pdfPrefetch,
      // Convert only where the outcome is actionable: with forceEngine
      // unset, the retry loop recovers PDFFetchProxyError via the browser
      // fallback; with a scalar forceEngine=pdf, this engine is pinned
      // with no fallback in the list, so the clean error surfaces instead
      // of the raw TypeError. An ARRAY forceEngine must NOT convert — the
      // retry loop bypasses recovery for any forceEngine, and the raw
      // error is what lets the waterfall continue through the remaining
      // forced engines.
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
  // With fire-engine available this engine never downloads files itself:
  // buildFallbackList routes file URLs through the browser engines and the
  // file arrives here via pdfPrefetch. Reaching the direct download means
  // either an explicit forceEngine pin (the escape hatch, kept working) or
  // a browser handoff that came back empty (pdfPrefetch === null) —
  // signal antibot so the retry loop can give the browser another round
  // trip, exactly like a handoff whose bytes failed the PDF sniff. In
  // self-hosted deployments (no fire-engine) the direct download stays the
  // primary path. Ordinary pages (no "pdf" flag) keep declining via
  // EngineUnsuccessfulError so the waterfall just moves on.
  if (
    useFireEngine &&
    meta.internalOptions.forceEngine === undefined &&
    meta.pdfPrefetch == null
  ) {
    // A cross-type handoff (a .pdf URL serving a docx or an image) lands in
    // documentPrefetch/imagePrefetch: the file is in hand, just not for this
    // engine — decline so the waterfall reaches the engine that can parse it.
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
  const includePageMarkdown = getPDFPageMarkdown(meta.options.parsers);
  const includeBlocks = getPDFBlocks(meta.options.parsers);
  const pageMarkers = getPDFPageMarkers(meta.options.parsers);

  if (includePageMarkdown && !config.FIRE_PDF_BASE_URL) {
    throw new Error(
      "Physical page markdown is unavailable because FirePDF is not configured",
    );
  }

  if (includeBlocks && !config.FIRE_PDF_BASE_URL) {
    throw new Error(
      "Typed blocks are unavailable because FirePDF is not configured",
    );
  }

  if (pageMarkers && !config.FIRE_PDF_BASE_URL) {
    throw new Error(
      "Page markers are unavailable because FirePDF is not configured",
    );
  }

  if (!shouldParse) {
    if (meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null) {
      // The raw path returns the file base64'd inline in the response, so it
      // keeps the historical cap even when a large prefetch (fire-engine GCS
      // handoff) materialized a bigger file on disk for the parse path.
      const prefetchSize = (await stat(meta.pdfPrefetch.filePath)).size;
      if (prefetchSize > PDF_DOWNLOAD_MAX_FILE_SIZE) {
        throw new UnsupportedFileError("File exceeds size limit");
      }
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
        // downloaded content isn't a valid PDF
        // (null prefetch = browser round trip ran but delivered no file —
        // still PDFAntibotError so the retry loop can give the browser
        // another shot, exactly like the no-prefetch case)
        if (meta.pdfPrefetch == null) {
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

  const forceFirePDF =
    (!!meta.options.__forceFirePDF ||
      includePageMarkdown ||
      includeBlocks ||
      pageMarkers) &&
    !!config.FIRE_PDF_BASE_URL;

  // The MinerU diversion is deterministic on the scrape id (see
  // mineruDiverted) so this routing verdict is BY CONSTRUCTION the same
  // one inside byReferenceReachableForRequest() — and the same one
  // fire-engine used when granting the handoff. Forced Fire PDF takes
  // precedence and is never diverted.
  const routeToMinerU = !forceFirePDF && mineruDiverted(meta);

  // Only admit large downloads when the by-reference FirePDF path is even
  // reachable for this request (same predicate the routing gate uses; the
  // gate adds the signals that need the file first). Otherwise keep the
  // historical cap — an oversized file would only burn bandwidth and temp
  // disk to fall through to text-only extraction.
  // The shared predicate covers fast-mode exclusion and the MinerU
  // diversion too, so this is the same verdict fire-engine used when
  // granting (or withholding) the handoff for this request.
  const byReferenceReachable = byReferenceReachableForRequest(meta);

  const { response, tempFilePath } =
    meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null
      ? { response: meta.pdfPrefetch, tempFilePath: meta.pdfPrefetch.filePath }
      : await fetchPdfFileGuardingProxyFailure(meta, () =>
          downloadFile(
            meta.id,
            meta.rewrittenUrl ?? meta.url,
            meta.options.skipTlsVerification,
            {
              headers: meta.options.headers,
              signal: meta.abort.asSignal(),
            },
            // Parse path streams to disk and can hand large files to FirePDF
            // by GCS reference, so it admits more than the raw fetch path —
            // up to the requesting team's large-PDF limit.
            byReferenceReachable
              ? largePdfLimitBytes(meta)
              : PDF_DOWNLOAD_MAX_FILE_SIZE,
          ),
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
      // (null prefetch = browser round trip ran but delivered no file —
      // still PDFAntibotError so the retry loop can give the browser
      // another shot, exactly like the no-prefetch case)
      if (meta.pdfPrefetch == null) {
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
    // True page count of the document before maxPages capping. Stays undefined
    // when native detection fails, so it can be omitted from the response.
    let totalPageCount: number | undefined;
    let metadataTitle: string | undefined;
    let rustMarkdownForShadow: string | undefined;
    let shadowPdfType: string | undefined;
    let shadowConfidence: number | undefined;
    let shadowIsComplex: boolean | undefined;
    let shadowIneligibleReason: string | null | undefined;
    let shadowPagesNeedingOcr: number[] | undefined;

    const rustEnabled = !!config.PDF_RUST_EXTRACT_ENABLE;
    const logger = meta.logger.child({ method: "scrapePDF/processPdf" });

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
          const result = await withPdfExtractionPermit(() =>
            detectPdf(tempFilePath, nativeCtx),
          );
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

        totalPageCount = detection.pageCount;
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
          const result = await withPdfExtractionPermit(() =>
            processPdf(tempFilePath, maxPages ?? undefined, nativeCtx),
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
    const skipOCR =
      rustEnabled && mode === "fast" && !routeToMinerU && !forceFirePDF;

    // Large PDFs can't travel inline as base64 JSON (fire-pdf's body limit,
    // V8 string ceilings, worker memory), so they go to the fire-pdf async
    // pipeline by GCS reference — streamed from the temp file, never
    // buffered. ZDR stays out: the by-reference input object persists in
    // GCS. MinerU-diverted traffic keeps its route decision (MinerU can't
    // take these sizes, so the legacy chain below just skips through).
    // By-reference has its own explicit switch instead of riding
    // FIRE_PDF_PERCENT: there is no alternative engine at this size, so a
    // sampled-out cohort would only degrade to text-only extraction. The
    // shared predicate matches the download-admission decision above; only
    // the file-dependent conditions are added here.
    if (!result && !skipOCR) {
      const fileSizeBytes = (await stat(tempFilePath)).size;
      const useFirePdfByReference =
        byReferenceReachable &&
        fileSizeBytes >= FIRE_PDF_MAX_FILE_SIZE &&
        fileSizeBytes <= largePdfLimitBytes(meta);

      if (useFirePdfByReference) {
        if (effectivePageCount <= 0) {
          // fire-pdf can't probe pages without the bytes, so by-reference
          // submits require our page count. Fall through to the legacy
          // chain (status quo for oversized files).
          meta.logger.warn(
            "Large PDF has no page-count estimate; cannot submit by reference",
            {
              method: "scrapePDF",
              event: "fire_pdf_by_reference_no_pages",
              file_size_bytes: fileSizeBytes,
              scrape_id: meta.id,
              team_id: meta.internalOptions.teamId,
            },
          );
        } else {
          // The whole attempt — raw-sha cache, content adoption, handoff
          // rewrite / streaming upload, fresh async submit — lives in
          // by-reference-flow.ts; this router only gates and reconciles.
          // A null return means the input never made it into the fire-pdf
          // bucket: fall through to the legacy chain, whose oversized-skip
          // warning below still fires (pre-by-reference behavior).
          const byRefResult = await runFirePdfByReferenceAttempt({
            meta,
            tempFilePath,
            fileSizeBytes,
            pagesEstimate: effectivePageCount,
            mode,
            maxPages,
            includePageMarkdown,
            includeBlocks,
            pageMarkers,
          });
          if (byRefResult) {
            result = byRefResult;
            effectivePageCount = reconcilePageCountWithFirePdf(
              effectivePageCount,
              result,
            );
          }
        }
      }
    }

    if (!result && !skipOCR) {
      const fileSizeBytes = (await stat(tempFilePath)).size;
      // Only materialize the base64 payload for engines that can accept it
      // inline: FirePDF (<30MB, or forced up to fire-pdf's wire ceiling)
      // and MinerU (<19MB). Files above that reach this chain only as
      // fallthrough (ZDR, MinerU-diverted, by-reference failure) and go
      // straight to pdf-parse, which reads from disk — buffering and
      // base64-encoding hundreds of MB here would only burn worker memory.
      // Inline bytes are only materialized when an engine that can accept
      // them on THIS route and size actually exists: FirePDF inline (not
      // MinerU-diverted; under its cap, or forced up to the wire ceiling)
      // or RunPod MU (under its own cap). Everything else goes straight to
      // disk-based pdf-parse without a wasted base64 pass.
      const firePdfInlineUsable =
        (forceFirePDF ||
          (!routeToMinerU &&
            !!config.FIRE_PDF_ENABLE &&
            !!config.FIRE_PDF_BASE_URL)) &&
        (fileSizeBytes < FIRE_PDF_MAX_FILE_SIZE ||
          (forceFirePDF &&
            fileSizeBytes <= FIRE_PDF_INLINE_HARD_MAX_FILE_SIZE));
      const runpodMuUsable =
        !forceFirePDF &&
        fileSizeBytes < MAX_FILE_SIZE &&
        !!config.RUNPOD_MU_API_KEY &&
        !!config.RUNPOD_MU_POD_ID;
      const inlineEligible = firePdfInlineUsable || runpodMuUsable;
      const base64Content = inlineEligible
        ? (await readFile(tempFilePath)).toString("base64")
        : undefined;

      if (!result && forceFirePDF && base64Content === undefined) {
        // Forced FirePDF (pages/blocks/markers) with no viable transport:
        // the file exceeds the inline ceiling and the by-reference path was
        // unavailable (ZDR) or failed. Erroring beats returning an empty
        // document as a 200.
        throw new Error(
          `PDF (${fileSizeBytes} bytes) exceeds the FirePDF inline ceiling and by-reference submission was unavailable`,
        );
      }

      if (
        !forceFirePDF &&
        !routeToMinerU &&
        config.FIRE_PDF_ENABLE &&
        config.FIRE_PDF_BASE_URL &&
        fileSizeBytes >= FIRE_PDF_MAX_FILE_SIZE
      ) {
        meta.logger.warn("PDF skipped by Fire PDF: exceeds size cap", {
          method: "scrapePDF",
          event: "pdf_skipped_size",
          engine: "firepdf",
          file_size_bytes: fileSizeBytes,
          max_size_bytes: FIRE_PDF_MAX_FILE_SIZE,
          scrape_id: meta.id,
          team_id: meta.internalOptions.teamId,
        });
      }

      // Route a percentage of traffic to Fire PDF instead of MinerU.
      // forceFirePDF always wins; skip percentage-based Fire PDF when
      // we explicitly routed to MinerU via MINERU_PERCENT.
      const useFirePDF =
        base64Content !== undefined &&
        (forceFirePDF ||
          (!routeToMinerU &&
            config.FIRE_PDF_ENABLE &&
            config.FIRE_PDF_BASE_URL &&
            fileSizeBytes < FIRE_PDF_MAX_FILE_SIZE &&
            Math.random() * 100 < config.FIRE_PDF_PERCENT));

      if (useFirePDF) {
        // Async is a server-controlled cohort within traffic already selected
        // for FirePDF. ZDR and short-deadline requests are always kept out.
        const asyncDecision = decideFirePdfAsyncRoute({
          scrapeId: meta.id,
          teamId: meta.internalOptions.teamId,
          zeroDataRetention: meta.internalOptions.zeroDataRetention ?? false,
          remainingMs: meta.abort.scrapeTimeout(),
          requestOptIn: getFirePdfAsync(meta.options.parsers),
          percentage: config.FIRE_PDF_ASYNC_PERCENT,
          forceTeamIds: config.FIRE_PDF_ASYNC_FORCE_TEAM_IDS,
          disableTeamIds: config.FIRE_PDF_ASYNC_DISABLE_TEAM_IDS,
          allowRequestOverride: config.FIRE_PDF_ASYNC_ALLOW_REQUEST_OVERRIDE,
          bulkOrigin: Boolean(meta.internalOptions.crawlId),
          bulkOriginPercentage: config.FIRE_PDF_ASYNC_BULK_ORIGIN_PERCENT,
        });
        const useAsync = asyncDecision.enabled;
        if (useAsync) {
          meta.logger.info("Routing FirePDF request to async jobs", {
            method: "scrapePDF",
            event: "fire_pdf_async_routed",
            reason: asyncDecision.reason,
            percentage: config.FIRE_PDF_ASYNC_PERCENT,
            bulk_origin_percentage: config.FIRE_PDF_ASYNC_BULK_ORIGIN_PERCENT,
            scrape_id: meta.id,
            team_id: meta.internalOptions.teamId,
            crawl_id: meta.internalOptions.crawlId,
          });
        }
        try {
          const firePdfMeta = {
            ...meta,
            logger: meta.logger.child({
              method: useAsync ? "scrapePDF/firePDFAsync" : "scrapePDF/firePDF",
            }),
          };
          if (useAsync) {
            try {
              result = await scrapePDFWithFirePDFAsync(
                firePdfMeta,
                base64Content,
                maxPages,
                effectivePageCount,
                mode,
                undefined,
                includePageMarkdown,
                includeBlocks,
                pageMarkers,
              );
            } catch (error) {
              if (
                (!includePageMarkdown && !includeBlocks && !pageMarkers) ||
                error instanceof RemoveFeatureError ||
                error instanceof AbortManagerThrownError
              ) {
                throw error;
              }
              meta.logger.warn(
                "FirePDF async page markdown/blocks/markers failed -- retrying synchronously",
                {
                  method: "scrapePDF/firePDFFallback",
                  error,
                  scrape_id: meta.id,
                  team_id: meta.internalOptions.teamId,
                },
              );
              result = await scrapePDFWithFirePDF(
                {
                  ...firePdfMeta,
                  logger: meta.logger.child({
                    method: "scrapePDF/firePDFSyncFallback",
                  }),
                },
                base64Content,
                maxPages,
                effectivePageCount,
                mode,
                includePageMarkdown,
                includeBlocks,
                pageMarkers,
              );
            }
          } else {
            result = await scrapePDFWithFirePDF(
              firePdfMeta,
              base64Content,
              maxPages,
              effectivePageCount,
              mode,
              includePageMarkdown,
              includeBlocks,
              pageMarkers,
            );
          }
          effectivePageCount = reconcilePageCountWithFirePdf(
            effectivePageCount,
            result,
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
            event: "pdf_engine_fallback",
            scrape_id: meta.id,
            team_id: meta.internalOptions.teamId,
            from_engine: "firepdf",
            to_engine: "mineru",
            // Coerce both to strings defensively — if someone throws a
            // non-Error (e.g. a plain object or primitive), `.name` /
            // `.message` could be undefined or non-string, and `.slice` would
            // throw inside the fallback logger, masking the original failure.
            error_class:
              (error as { name?: unknown })?.name != null
                ? String((error as { name?: unknown }).name)
                : undefined,
            error_message: String(
              (error as { message?: unknown })?.message ?? "",
            ).slice(0, 500),
          });
        }
      }

      if (
        !result &&
        !forceFirePDF &&
        fileSizeBytes >= MAX_FILE_SIZE &&
        config.RUNPOD_MU_API_KEY &&
        config.RUNPOD_MU_POD_ID
      ) {
        meta.logger.warn("PDF skipped by RunPod MU: exceeds size cap", {
          method: "scrapePDF",
          event: "pdf_skipped_size",
          engine: "mineru",
          file_size_bytes: fileSizeBytes,
          max_size_bytes: MAX_FILE_SIZE,
          scrape_id: meta.id,
          team_id: meta.internalOptions.teamId,
        });
      }

      if (
        !result &&
        !forceFirePDF &&
        fileSizeBytes < MAX_FILE_SIZE &&
        base64Content !== undefined &&
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
      ...(includePageMarkdown && result?.pageMarkdown
        ? {
            pages: result.pageMarkdown.map(page => ({
              pageNumber: page.page,
              markdown: page.markdown,
            })),
          }
        : {}),
      ...(includeBlocks && result?.blocks
        ? { blocks: toPublicBlocks(result.blocks) }
        : {}),
      pdfMetadata: {
        numPages: effectivePageCount,
        totalPages: totalPageCount,
        title: metadataTitle,
      },

      contentType: "application/pdf",
      // Report the proxy that actually delivered the file: a browser
      // handoff may have come through the stealth proxy, while the direct
      // download always uses the basic route.
      proxyUsed: meta.pdfPrefetch?.proxyUsed ?? "basic",
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
