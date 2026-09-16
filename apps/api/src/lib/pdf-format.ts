// Recognizing PDF bytes. PDF readers accept leading bytes before the %PDF
// header — mupdf, pdfium and poppler all search the first 1KB for it — and
// servers do produce them: a download endpoint that echoes a multipart
// upload wraps the file in a boundary line and part headers. So the header
// is looked for within that window rather than at byte 0, and callers can
// normalize the bytes to start at it.

export const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");
const DASH = 0x2d;

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/**
 * Byte offset of the %PDF header within the first 1KB of a buffer, or -1
 * when there is none. A versioned header (`%PDF-1.7`) wins over an earlier
 * bare `%PDF`, which leading bytes can contain by accident (a filename in a
 * multipart part header, say) — otherwise a bare match is accepted, as it
 * always has been.
 */
export function pdfHeaderOffset(buf: Buffer): number {
  const window = buf.subarray(0, Math.min(buf.length, PDF_SNIFF_WINDOW));
  let bare = -1;
  for (
    let at = window.indexOf(PDF_MAGIC);
    at !== -1;
    at = window.indexOf(PDF_MAGIC, at + 1)
  ) {
    const versioned =
      window[at + PDF_MAGIC.length] === DASH &&
      isDigit(window[at + PDF_MAGIC.length + 1]);
    if (versioned) return at;
    if (bare === -1) bare = at;
  }
  return bare;
}

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdfBuffer(buf: Buffer): boolean {
  return pdfHeaderOffset(buf) !== -1;
}

/**
 * The buffer from its %PDF header on; unchanged when the header is at byte
 * 0 or not within the sniff window at all.
 */
export function fromPdfHeader(buf: Buffer): Buffer {
  const offset = pdfHeaderOffset(buf);
  return offset > 0 ? buf.subarray(offset) : buf;
}
