/**
 * Page count to report after the pdf-parse fallback. pdf-parse stops at its
 * page cap, so a count from native detection can only come down to the pages
 * it parsed. A count of 0 (native detection failed) stays 0: that path has
 * always billed the base credit only, and a parser cap must not raise prices.
 *
 * Lives in its own module so tests that mock the pdf-parse module keep the
 * real reconciliation. Pure and synchronous so it is unit-testable on its own.
 */
export function reconcilePageCountWithPdfParse(
  current: number,
  pdfParseResult: { pagesProcessed?: number } | null | undefined,
): number {
  const parsed = pdfParseResult?.pagesProcessed;
  if (parsed === undefined || current <= 0) return current;
  return Math.min(current, parsed);
}
