import { Meta } from "../..";
import { config } from "../../../../config";
import { robustFetch } from "../../lib/fetch";
import { z } from "zod";
import type { PDFProcessorResult } from "./types";
import type {
  PDFBlockPage,
  PDFMode,
  PDFTableFormat,
} from "../../../../controllers/v2/types";
import { safeMarkdownToHtml } from "./markdownToHtml";
import {
  createPdfCacheKey,
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../lib/gcs-pdf-cache";

/**
 * Reconcile an existing page count with what fire-pdf reported.
 *
 * Used after `scrapePDFWithFirePDF` returns. The original bug: when Rust
 * extraction (`processPdf`) threw on a malformed-but-still-renderable PDF,
 * `effectivePageCount` stayed at 0; fire-pdf would then process the PDF
 * fine but its `pages_processed` value was dropped on the floor, so
 * `pdfMetadata.numPages` shipped as 0 and billing under-counted.
 *
 * Semantics:
 *   - If fire-pdf didn't report a count (older fire-pdf builds, or stale
 *     cache hits), keep the current value — no signal to act on.
 *   - Otherwise take the max — never shrink a count that an upstream pass
 *     (detectPdf / processPdf) already established. fire-pdf can be
 *     called with `max_pages` capping its own processing below the true
 *     PDF length, and the upstream count is the authoritative one when
 *     both succeeded.
 *
 * Pure / synchronous so it's trivially unit-testable; the integration in
 * `index.ts` is just `effectivePageCount = reconcilePageCountWithFirePdf(...)`.
 */
export function reconcilePageCountWithFirePdf(
  current: number,
  firePdfResult: { pagesProcessed?: number } | null | undefined,
): number {
  const fromFirePdf = firePdfResult?.pagesProcessed;
  if (fromFirePdf === undefined) return current;
  return Math.max(current, fromFirePdf);
}

export type FirePdfRequestOptions = {
  /** Request per-page typed blocks (fire-pdf `include_blocks`). */
  includeBlocks?: boolean;
  /** Table rendering: markdown | html | dynamic (fire-pdf `tableFormat`). */
  tableFormat?: PDFTableFormat;
};

export async function scrapePDFWithFirePDF(
  meta: Meta,
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
  mode?: PDFMode,
  firePdfOptions?: FirePdfRequestOptions,
): Promise<PDFProcessorResult> {
  const logger = meta.logger;
  const includeBlocks = firePdfOptions?.includeBlocks === true;
  const tableFormat = firePdfOptions?.tableFormat;

  // Cache layout:
  //   - `ocr` mode reads/writes a dedicated `…-ocr.json` bucket. ocr
  //     requests explicitly want forced layout-mode OCR, so they must
  //     not be served a base-cache entry that was written by `auto`.
  //   - `auto` (and legacy undefined-mode) reads/writes the base
  //     `firepdf-<sha>.json` bucket — same key main has always used,
  //     so existing entries keep working. As a free upgrade, auto also
  //     reads the ocr bucket as a fallback: if some prior `ocr` run
  //     already produced markdown for this PDF, reuse it rather than
  //     running fire-pdf again.
  //   - `fast` is bypassed entirely (hard cost ceiling — must fail on
  //     scanned PDFs, not serve a cached OCR result).
  // blocks / non-default tableFormat responses bypass the PDF cache in both
  // directions: existing entries were written without blocks (a hit would
  // silently drop the requested format), and writing the variant would need
  // a key split that isn't worth it until adoption justifies it.
  const cacheable =
    mode !== "fast" &&
    !maxPages &&
    !meta.internalOptions.zeroDataRetention &&
    !includeBlocks &&
    tableFormat === undefined;
  const ownVariant: string | undefined = mode === "ocr" ? "ocr" : undefined;
  const lookupVariants: (string | undefined)[] =
    mode === "ocr" ? ["ocr"] : [undefined, "ocr"];

  if (cacheable) {
    for (const variant of lookupVariants) {
      try {
        const cached = await getPdfResultFromCache(
          base64Content,
          "firepdf",
          variant,
        );
        if (cached) {
          logger.info("Using cached FirePDF result", {
            scrapeId: meta.id,
            requestedMode: mode,
            cacheVariant: variant ?? "base",
          });
          // Cache entries written before pagesProcessed existed don't carry
          // the field. Fall back to the caller's pagesProcessed argument so
          // billing on a stale hit doesn't silently regress to 0.
          return {
            ...cached,
            pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
          };
        }
      } catch (error) {
        logger.warn("Error checking FirePDF cache, proceeding", {
          error,
          cacheVariant: variant ?? "base",
        });
      }
    }
  }

  meta.abort.throwIfAborted();

  const startedAt = Date.now();

  logger.info("FirePDF started", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    maxPages,
    pagesProcessed,
  });

  const zdr = meta.internalOptions.zeroDataRetention === true;
  const pdfSha256 = createPdfCacheKey(base64Content);

  // Explicit deadline contract with fire-pdf (mirrors mineru-api):
  //   timeout    — remaining scrape-tier budget in ms (from AbortManager)
  //   created_at — epoch ms when we handed the budget over to fire-pdf
  //
  // fire-pdf computes remaining = timeout - (now - created_at) and can
  // return 503 if the budget is spent. Previously it only saw the abort
  // signal from the HTTP connection, which it didn't observe — so work
  // kept running past the caller's timeout and the user got a late
  // failure instead of a fast deadline-exceeded response.
  //
  // scrapeTimeout() returns undefined if no scrape-tier deadline is set
  // (e.g., internal tests, CLI). Don't send timeout in that case so
  // fire-pdf applies its own default.
  const fireScrapeTimeout = meta.abort.scrapeTimeout();
  const deadlineFields: { timeout?: number; created_at?: number } = {};
  if (fireScrapeTimeout !== undefined && fireScrapeTimeout > 0) {
    deadlineFields.timeout = Math.floor(fireScrapeTimeout);
    deadlineFields.created_at = Date.now();
  }

  const resp = await robustFetch({
    url: `${config.FIRE_PDF_BASE_URL}/ocr`,
    method: "POST",
    headers: config.FIRE_PDF_API_KEY
      ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
      : undefined,
    body: {
      pdf: base64Content,
      scrape_id: meta.id,
      ...(maxPages !== undefined && { max_pages: maxPages }),
      ...(mode !== undefined && { mode }),
      // Enrichment for the fire-pdf jobs DB / dashboard. fire-pdf treats
      // these as optional — older fire-pdf builds will ignore unknown fields.
      team_id: meta.internalOptions.teamId,
      ...(meta.internalOptions.crawlId && {
        crawl_id: meta.internalOptions.crawlId,
      }),
      ...(zdr ? {} : { url: meta.rewrittenUrl ?? meta.url }),
      pdf_sha256: pdfSha256,
      source: "firecrawl",
      zdr,
      ...(includeBlocks && { include_blocks: true }),
      ...(tableFormat !== undefined && { tableFormat }),
      ...deadlineFields,
    },
    logger,
    schema: z.object({
      markdown: z.string(),
      failed_pages: z.array(z.number()).nullable(),
      pages_processed: z.number().optional(),
      // Present only when include_blocks was sent (fire-pdf blocks-schema
      // v2). Loose on purpose: fire-pdf may add block fields — pass them
      // through rather than strip/fail.
      pages: z.array(z.looseObject({})).optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  const durationMs = Date.now() - startedAt;
  const pages = resp.pages_processed ?? pagesProcessed;

  logger.info("FirePDF completed", {
    scrapeId: meta.id,
    url: meta.rewrittenUrl ?? meta.url,
    durationMs,
    markdownLength: resp.markdown.length,
    failedPages: resp.failed_pages,
    pagesProcessed: pages,
    perPageMs: pages ? Math.round(durationMs / pages) : undefined,
  });

  const processorResult: PDFProcessorResult & { markdown: string } = {
    markdown: resp.markdown,
    html: await safeMarkdownToHtml(resp.markdown, logger, meta.id),
    pagesProcessed: pages,
    ...(resp.pages !== undefined && {
      blocks: resp.pages as unknown as PDFBlockPage[],
    }),
  };

  if (cacheable) {
    try {
      await savePdfResultToCache(
        base64Content,
        processorResult,
        "firepdf",
        ownVariant,
      );
    } catch (error) {
      logger.warn("Error saving FirePDF result to cache", { error });
    }
  }

  return processorResult;
}
