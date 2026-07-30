// Line-item billing primitives.
//
// A scrape's cost isn't a single number against a single pool — a scrape can
// simultaneously incur a base charge (CREDITS), a format premium (e.g. JSON
// output → JSON_CREDITS), and document parsing (DOCUMENT_CREDITS). Modelling
// the cost as a list of tagged line items lets each billable dimension meter
// against its own Autumn feature while the ledger total stays the plain sum.
//
// This is the extension point: a new metered dimension is a new feature id in
// autumn.service.ts plus a line tagged with it in scrape-billing.ts. Nothing
// downstream (tracking, refunds, projection) needs to know the dimensions.

import {
  CREDITS_FEATURE_ID,
  DOCUMENT_CREDITS_FEATURE_ID,
} from "../services/autumn/autumn.service";

export type CreditLine = {
  // The Autumn feature id this portion of the charge meters against.
  feature: string;
  credits: number;
  // Human-readable origin of the charge (e.g. "base", "json", "pdf-pages").
  // Purely for logging/analytics — billing only ever uses feature + credits.
  reason: string;
};

/** Total credits across all lines — the amount committed to the ledger. */
export function sumCreditLines(lines: CreditLine[]): number {
  return lines.reduce((total, line) => total + line.credits, 0);
}

/**
 * Collapses lines into `{ feature -> total credits }`, dropping non-positive
 * buckets. This is what drives the per-feature Autumn track/refund calls.
 */
export function groupCreditsByFeature(
  lines: CreditLine[],
): Record<string, number> {
  const byFeature: Record<string, number> = {};
  for (const line of lines) {
    byFeature[line.feature] = (byFeature[line.feature] ?? 0) + line.credits;
  }
  for (const feature of Object.keys(byFeature)) {
    if (byFeature[feature] <= 0) delete byFeature[feature];
  }
  return byFeature;
}

/**
 * Re-tags every line onto a single feature. Used to preserve endpoint-level
 * precedence — a scrape performed as part of a search meters entirely against
 * SEARCH_CREDITS regardless of the formats/documents involved.
 */
export function retagAllLines(
  lines: CreditLine[],
  feature: string,
): CreditLine[] {
  return lines.map(line => ({ ...line, feature }));
}

const DOCUMENT_CONTENT_TYPE_MATCHERS = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
];

/**
 * True when the resolved content type is a PDF or office document. Compares the
 * media type before any `;` parameters, exactly, so `application/pdfx` does not
 * match `application/pdf`.
 */
export function isDocumentContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return DOCUMENT_CONTENT_TYPE_MATCHERS.includes(mediaType);
}

/**
 * Re-tags the base and document-parsing portions of a scrape onto
 * DOCUMENT_CREDITS when the scrape resolved to a document. Format premiums
 * (e.g. JSON) keep their own tag — a JSON extraction over a PDF still meters
 * the JSON premium against JSON_CREDITS.
 */
export function applyDocumentTag(lines: CreditLine[]): CreditLine[] {
  return lines.map(line =>
    line.feature === CREDITS_FEATURE_ID
      ? { ...line, feature: DOCUMENT_CREDITS_FEATURE_ID }
      : line,
  );
}
