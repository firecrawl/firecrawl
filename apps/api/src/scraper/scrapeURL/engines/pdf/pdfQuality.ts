/**
 * Deterministic assessment of a Rust-extracted PDF result, used by
 * `getIneligibleReason` to catch degenerate extractions that the detector
 * classifies as usable: documents whose body text is suppressed (e.g.
 * white-filled text inside nested Form XObjects painted over by an opaque
 * raster) while page headers survive, so the result looks like a short
 * header-only document with `pdfType: "TextBased"` and high confidence.
 *
 * This module is pure: it never invokes another parser and performs no I/O.
 * Cutoffs come from a calibration corpus of hand-built PDFs run through the
 * real detector (see the PR description for issue #5759): the residual
 * floor sits between the largest degenerate residual (296 alnum chars)
 * and the smallest legitimate one (519, a slide deck), and the raw-density
 * ceiling sits between the densest degenerate (238 alnum/page) and the
 * sparsest healthy document (367 alnum/page).
 */

// Docs shorter than this are exempt from the density check: with one or two
// pages there is too little evidence to call the extraction degenerate.
export const MIN_PAGES_FOR_DENSITY_CHECK = 3;

// A document is suspect when the non-boilerplate content (see
// `computeResidualAlnum`) is smaller than this AND the overall density is
// below `RAW_ALNUM_PER_PAGE_CEILING`. The absolute floor is what catches
// verbose-header degenerates, whose repeated headers inflate the raw
// density while contributing almost no unique content.
export const RESIDUAL_ALNUM_FLOOR = 400;
export const RAW_ALNUM_PER_PAGE_CEILING = 300;

export const SPARSE_EXTRACTION_REASON = "sparse extraction";

export function ocrFlaggedReason(page: number): string {
  return `page ${page} flagged for OCR`;
}

const OCR_FLAGGED_PREFIX = "page ";
const OCR_FLAGGED_SUFFIX = " flagged for OCR";

/** Whether an ineligibility reason came from the extraction-quality checks. */
export function isExtractionQualityRejection(reason: string | null): boolean {
  if (reason === SPARSE_EXTRACTION_REASON) {
    return true;
  }
  return (
    reason !== null &&
    reason.startsWith(OCR_FLAGGED_PREFIX) &&
    reason.endsWith(OCR_FLAGGED_SUFFIX)
  );
}

const ALNUM_PATTERN = /[\p{L}\p{N}]/gu;

function countAlphanumeric(text: string): number {
  return (text.match(ALNUM_PATTERN) ?? []).length;
}

/**
 * Collapse page numbers, editions and other digits so that repeated
 * headers differing only in their numbering compare equal.
 */
function normalizeLine(line: string): string {
  return line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * Split the markdown into lines and drop every line whose digit-normalized
 * form repeats on at least half the pages: repeated headers, footers and
 * running titles carry no page-specific content. All copies are removed
 * rather than keeping one, because a line present on most pages contributes
 * nothing distinctive to the document. Returns the surviving alphanumeric
 * count alongside the raw count.
 */
export function computeResidualAlnum(
  markdown: string,
  effectivePages: number,
): { rawAlnum: number; residualAlnum: number } {
  const rawAlnum = countAlphanumeric(markdown);
  const lines = markdown
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(line => line.length > 0);

  const occurrences = new Map<string, number>();
  for (const line of lines) {
    occurrences.set(line, (occurrences.get(line) ?? 0) + 1);
  }

  const repeatThreshold = Math.ceil(effectivePages / 2);
  let residualAlnum = 0;
  for (const line of lines) {
    if ((occurrences.get(line) ?? 0) < repeatThreshold) {
      residualAlnum += countAlphanumeric(line);
    }
  }

  return { rawAlnum, residualAlnum };
}

export interface PdfExtractionQuality {
  /** True when the extraction looks degenerate and should fall back. */
  suspicious: boolean;
  rawAlnum: number;
  rawAlnumPerPage: number;
  residualAlnum: number;
  effectivePages: number;
}

/**
 * Judge whether a Rust extraction is suspiciously sparse for the number of
 * pages it claims to cover. Fails open: unknown page counts, very short
 * documents and empty markdown are never suspicious here, so the existing
 * classification and empty-markdown checks stay authoritative for those.
 */
export function assessPdfExtractionQuality(
  markdown: string | undefined,
  effectivePages: number,
): PdfExtractionQuality {
  const base = {
    rawAlnum: 0,
    rawAlnumPerPage: 0,
    residualAlnum: 0,
    effectivePages,
  };
  if (!markdown || !Number.isFinite(effectivePages) || effectivePages <= 0) {
    return { ...base, suspicious: false };
  }

  const { rawAlnum, residualAlnum } = computeResidualAlnum(
    markdown,
    effectivePages,
  );
  const rawAlnumPerPage = rawAlnum / effectivePages;
  return {
    ...base,
    rawAlnum,
    rawAlnumPerPage,
    residualAlnum,
    suspicious:
      effectivePages >= MIN_PAGES_FOR_DENSITY_CHECK &&
      residualAlnum < RESIDUAL_ALNUM_FLOOR &&
      rawAlnumPerPage < RAW_ALNUM_PER_PAGE_CEILING,
  };
}

/**
 * Find the first OCR-flagged page inside the extracted range. The detector
 * reports 1-indexed page numbers, and extraction covers pages 1 through
 * `effectivePages`, so only flags in that range can describe content this
 * result was supposed to return. Returns null when the range is unknown
 * (fail open) or no flag falls inside it.
 */
export function findInRangeOcrFlag(
  pagesNeedingOcr: readonly number[] | undefined,
  effectivePages: number,
): number | null {
  if (
    !pagesNeedingOcr ||
    !Number.isFinite(effectivePages) ||
    effectivePages <= 0
  ) {
    return null;
  }
  for (const page of pagesNeedingOcr) {
    if (Number.isInteger(page) && page >= 1 && page <= effectivePages) {
      return page;
    }
  }
  return null;
}
