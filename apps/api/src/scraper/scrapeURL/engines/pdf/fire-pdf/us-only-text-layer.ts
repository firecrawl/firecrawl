import { processPdf } from "@mendable/firecrawl-rs";
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import type { PDFMode } from "../../../../../controllers/v2/types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../../lib/native-logging";
import {
  AbortManagerThrownError,
  type AbortInstance,
} from "../../../lib/abortManager";
import { UsOnlyUnavailableError } from "../../../error";
import { safeMarkdownToHtml } from "../markdownToHtml";
import { withPdfExtractionPermit } from "../semaphore";
import type { PDFProcessorResult } from "../types";

/**
 * Text-layer fallback for US-only teams.
 *
 * A US-only team's PDF goes only to the PDF service, pinned to US GPU
 * capacity. When that capacity is missing, the service refuses the request
 * (`region_unavailable`) or holds it until the caller's deadline, and the
 * scrape fails with 403 US_ONLY_UNAVAILABLE or 408 SCRAPE_TIMEOUT. That
 * happens even for a PDF whose text is already in its text layer and needs
 * no OCR.
 *
 * For such a PDF in auto mode, the engine falls back to extracting the text
 * layer in-process instead: the native extractor (firecrawl-rs
 * `processPdf`) or, failing that, pdf-parse. Both run inside the API worker
 * (GKE, us-east4), so the document goes to no other service. OCR mode, PDFs
 * that need OCR on any page, images, and requests for page markdown, blocks
 * or page markers are unchanged: they still need the PDF service, and a
 * refusal still fails them.
 */

/** Whether a US-only request may fall back to the text layer when the PDF service has no US capacity for it. */
export function usOnlyTextLayerFallbackEligible(input: {
  usOnly: boolean;
  mode: PDFMode | undefined;
  forceFirePDF: boolean;
  detectedPdfType: string | undefined;
}): boolean {
  return (
    input.usOnly &&
    input.mode !== "ocr" &&
    input.mode !== "fast" &&
    !input.forceFirePDF &&
    // Every page has a text layer. "Mixed" has pages that need OCR, which
    // a text-layer result would silently drop.
    input.detectedPdfType === "TextBased"
  );
}

/**
 * How much of the remaining scrape budget is kept back from the PDF service
 * so the text-layer fallback still has time to run if the service holds the
 * request to its deadline: 20 % of what is left, between 5 s and 30 s. The
 * native extractor takes well under a second for a text PDF. Undefined when
 * there is no deadline or too little time to split.
 */
export function usOnlyTextLayerReserveMs(
  remainingMs: number | undefined,
): number | undefined {
  if (remainingMs === undefined || !(remainingMs > 0)) return undefined;
  const reserve = Math.min(30_000, Math.max(5_000, remainingMs * 0.2));
  return remainingMs > reserve * 2 ? Math.floor(reserve) : undefined;
}

/** Marks the PDF service's share of the budget ending, as distinct from the caller's scrape deadline. */
class UsOnlyTextLayerReserveReached extends Error {
  name = "UsOnlyTextLayerReserveReached";
  constructor() {
    super("PDF service budget for a US-only text-layer PDF ran out");
  }
}

/**
 * `meta` with a scrape-tier deadline `reserveMs` before the caller's, for the
 * PDF service call. scrapeTimeout() reads the earlier deadline, so the
 * service is told the shorter budget. Call dispose() once the call settles.
 */
export function withUsOnlyTextLayerReserve(
  meta: Meta,
  reserveMs: number,
): { meta: Meta; dispose: () => void } {
  const remainingMs = meta.abort.scrapeTimeout() ?? 0;
  const budgetMs = Math.max(0, remainingMs - reserveMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();
  const instance: AbortInstance = {
    signal: controller.signal,
    timesOutAt: new Date(Date.now() + budgetMs),
    tier: "scrape",
    throwable: () => new UsOnlyTextLayerReserveReached(),
  };
  const abort = meta.abort.child(instance);
  return {
    meta: { ...meta, abort },
    dispose: () => {
      clearTimeout(timer);
      abort.dispose();
    },
  };
}

/**
 * Whether a PDF service failure is one the text-layer fallback answers: the
 * service refused for lack of US capacity, or its reserved budget ran out
 * while the caller's own deadline has not.
 */
export function isUsOnlyCapacityFailure(error: unknown, meta: Meta): boolean {
  if (error instanceof UsOnlyUnavailableError) {
    return error.firePdfReason === "region_unavailable";
  }
  return (
    error instanceof AbortManagerThrownError &&
    error.inner instanceof UsOnlyTextLayerReserveReached &&
    !meta.abort.isAborted()
  );
}

/**
 * The PDF's text layer as markdown from the native extractor, or null when
 * the extractor is off, fails, or finds no text (the caller then falls
 * through to pdf-parse).
 */
export async function extractTextLayerLocally(
  meta: Meta,
  tempFilePath: string,
  maxPages: number | undefined,
): Promise<PDFProcessorResult | null> {
  if (!config.PDF_RUST_EXTRACT_ENABLE) return null;
  try {
    const result = await withPdfExtractionPermit(() =>
      processPdf(tempFilePath, maxPages ?? undefined, {
        scrapeId: meta.id,
        url: meta.rewrittenUrl ?? meta.url,
      }),
    );
    emitNativeLogs(result.logs, meta.logger, "pdf.process");
    if (result.pdfType !== "TextBased" || !result.markdown?.trim()) {
      return null;
    }
    const html = await safeMarkdownToHtml(
      result.markdown,
      meta.logger,
      meta.id,
    );
    return { markdown: result.markdown, html };
  } catch (error) {
    extractAndEmitNativeLogs(error, meta.logger, "pdf.process");
    meta.logger.warn("US-only text-layer extraction failed; trying pdf-parse", {
      error,
      scrape_id: meta.id,
    });
    return null;
  }
}
