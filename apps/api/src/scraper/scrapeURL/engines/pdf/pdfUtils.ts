export const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdfBuffer(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, PDF_SNIFF_WINDOW));
  return window.includes(PDF_MAGIC);
}

/**
 * Free-tier PDF page ceiling. True when a preview/keyless team (team_id
 * prefix "preview" covers both legacy `preview_<iptoken>` and keyless
 * `preview_keyless_<ip>` shapes) asks to process more pages than the
 * configured limit allows. `limit <= 0` disables the check; an unknown
 * page count (0) never trips it — enforcement is best-effort by design.
 */
export function exceedsPreviewPdfPageLimit(
  teamId: string | undefined,
  effectivePageCount: number,
  limit: number,
): boolean {
  if (limit <= 0) return false;
  if (!teamId?.startsWith("preview")) return false;
  return effectivePageCount > limit;
}
