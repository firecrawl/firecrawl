import type { PDFProcessorResult } from "./types";

/**
 * Completeness guard for PDF stage results (firecrawl/firecrawl #5759).
 *
 * A 46-page gazette PDF returns only its repeated page header from the Rust
 * extractor (~3,096 chars, ~67/page) while pdf-parse extracts the full body
 * (86,666 chars, ~1,884/page). The extractor's own signals say nothing is
 * wrong (TextBased, confidence 1, not complex, no pages needing OCR), and
 * the fallback chain only triggers on errors — so a degenerate-but-
 * successful stage result shipped as a successful 46-credit scrape.
 *
 * The guard is deliberately *suspicion*, not rejection: low text density
 * only ever triggers verification against another extractor. A genuinely
 * sparse document (slide deck, one-line-per-page form) produces the same
 * sparse text from every engine, so the best result is retained with a
 * warning instead of an error. Nothing here proves a document is broken.
 *
 * Pure and synchronous so it is unit-testable on its own; it never imports
 * the native Rust module, so tests run without a built napi binary.
 */

/**
 * Below this many non-whitespace characters per processed page, a stage
 * result is suspicious. The reported failure sits at ~67 (Rust) and ~58
 * (FirePDF OCR) chars/page against ~1,884 (pdf-parse) and ~2,137
 * (pdftotext) for the same file, so 100 leaves a wide margin on both
 * sides: sparse-but-real documents (~40/page) still trigger verification,
 * which only costs a fallback run — it never drops their text.
 */
export const PDF_MIN_DENSITY_CHARS_PER_PAGE = 100;

/**
 * Density needs at least this many processed pages to mean anything. Below
 * it the estimate is at its weakest and a short document can legitimately
 * be sparse (a memo, a form, a title page) — and the FirePDF cache's tested
 * contract serves small sparse results as-is. The reported failure is 46
 * pages; the guard targets multi-page documents where a missing body is a
 * large, costly loss, and leaves short documents to the existing checks.
 */
export const PDF_MIN_PAGES_FOR_DENSITY_CHECK = 5;

export type PdfExtractionQuality = {
  /** True when the result looks too sparse to trust without verification. */
  suspicious: boolean;
  /** Human-readable reason, present exactly when suspicious. */
  reason?: string;
  /** Non-whitespace characters per processed page, when it could be computed. */
  densityCharsPerPage?: number;
};

/** Non-whitespace characters — markup and spacing must not inflate density. */
export function nonWhitespaceLength(text: string | undefined | null): number {
  if (!text) return 0;
  return text.replace(/\s/g, "").length;
}

/**
 * Pages a density measurement may be charged against. A request that caps
 * the run at maxPages only processed that many pages, so charging the full
 * document total would make a correctly extracted prefix look sparse.
 */
export function effectiveProcessedPages(
  pageCount: number | undefined,
  maxPages: number | undefined,
): number | undefined {
  if (pageCount === undefined) return undefined;
  if (maxPages === undefined) return pageCount;
  return Math.min(pageCount, maxPages);
}

export function assessPdfExtractionQuality(
  markdown: string | undefined | null,
  pagesProcessed: number | undefined,
): PdfExtractionQuality {
  const chars = nonWhitespaceLength(markdown);
  if (chars === 0) {
    // No text at all is a different signal from suspiciously little text,
    // and it already has owners: the Rust stage rejects an empty TextBased
    // result, and the FirePDF cache deliberately serves cached empty PDF
    // results as valid answers. This guard is only for non-empty
    // degenerate output — the reported #5759 failure has 3,096 chars.
    return { suspicious: false };
  }
  if (
    pagesProcessed === undefined ||
    !Number.isInteger(pagesProcessed) ||
    pagesProcessed < PDF_MIN_PAGES_FOR_DENSITY_CHECK
  ) {
    // No usable denominator: do not guess. A result that cannot be judged
    // is accepted as-is rather than pushed down the fallback chain.
    return { suspicious: false };
  }
  const density = chars / pagesProcessed;
  if (density < PDF_MIN_DENSITY_CHARS_PER_PAGE) {
    return {
      suspicious: true,
      reason: `low text density (${density.toFixed(1)} non-whitespace chars/page across ${pagesProcessed} pages)`,
      densityCharsPerPage: density,
    };
  }
  return { suspicious: false, densityCharsPerPage: density };
}

/** The Rust extractor result, structurally — no native import needed. */
export type RustPdfExtraction = {
  pdfType: string;
  confidence: number;
  isComplex: boolean;
  markdown?: string | null;
  pageCount: number;
};

/**
 * Whether the Rust stage's result may be used as-is, returning a rejection
 * reason or null. Extends the pre-existing checks (type, confidence,
 * complexity, emptiness) with the density check from #5759: a TextBased,
 * high-confidence, non-complex result that is suspiciously sparse is not
 * eligible, so the caller falls through to the next engine.
 *
 * `effectivePages` is the pages the stage actually processed
 * (maxPages-capped document total) — see effectiveProcessedPages.
 */
export function getRustPdfIneligibleReason(
  result: RustPdfExtraction,
  effectivePages: number | undefined,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  // Whitespace-only markdown is empty of visible text: the density
  // helper deliberately does not judge a zero-character result, so
  // judging emptiness on raw length would let such a result be adopted
  // as-is and skip the fallback chain.
  if (!nonWhitespaceLength(result.markdown))
    return "empty markdown (unexpected for TextBased)";
  const quality = assessPdfExtractionQuality(result.markdown, effectivePages);
  if (quality.suspicious)
    return `suspected incomplete extraction (${quality.reason})`;
  return null;
}

/**
 * The richer of two stage results, by non-whitespace markdown characters.
 * Used only when every engine was suspicious: the longest extraction is
 * the best available answer, and a tie keeps the earlier (cheaper) one.
 */
export function pickRicherPdfResult(
  a: PDFProcessorResult | null | undefined,
  b: PDFProcessorResult | null | undefined,
): PDFProcessorResult | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return nonWhitespaceLength(b.markdown) > nonWhitespaceLength(a.markdown)
    ? b
    : a;
}
