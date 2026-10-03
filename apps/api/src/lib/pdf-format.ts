// Recognizing PDF bytes. PDF readers accept leading bytes before the %PDF
// header — mupdf, pdfium and poppler all search the first 1KB for it — and
// servers do produce them: a download endpoint that echoes a multipart
// upload wraps the file in a boundary line and part headers. So the header
// is looked for within that window rather than at byte 0.
//
// Two predicates, on purpose. `isPdfBuffer` is the lenient acceptance gate
// for bytes already expected to be a PDF (URL, header, or handoff said so):
// any `%PDF` in the window, as it always has been, so nothing that parsed
// before is turned away. `pdfHeaderLineOffset` is the strict one: a real
// header line. It decides whether a body of unknown type is pulled out of
// the page path, and whether leading bytes are dropped — both places where
// acting on a mere mention of the magic would corrupt or lose the content.

export const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const DASH = 0x2d;
const DOT = 0x2e;
const LF = 0x0a;
const CR = 0x0d;

// What follows the magic on a header line: `-1.7` and the line end.
const HEADER_LINE_TAIL = 5;

/**
 * How many leading bytes a probe should carry so a header line that starts
 * in the last bytes of the sniff window is still seen whole. A candidate
 * only counts when its magic lies wholly inside the window (the same rule
 * the lenient gate applies), so the latest start is WINDOW - 4 and the tail
 * is all the look-ahead ever needed.
 */
export const PDF_HEADER_PROBE_BYTES = PDF_SNIFF_WINDOW + HEADER_LINE_TAIL;

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function sniffWindow(buf: Buffer): Buffer {
  return buf.subarray(0, Math.min(buf.length, PDF_SNIFF_WINDOW));
}

/**
 * Whether `at` starts a header line: `%PDF-1.7` (magic, dash, version) on
 * a line of its own — at the start of the buffer (a byte-order mark
 * allowed) or of a line, and ending the line. Leading bytes can mention
 * the magic (a filename in a multipart part header, say) without that
 * being the header. The look-ahead reads past the sniff window, which is
 * why probes carry PDF_HEADER_PROBE_BYTES.
 */
function isHeaderLineAt(buf: Buffer, at: number): boolean {
  const lineStart =
    at === 0 ||
    buf[at - 1] === LF ||
    buf[at - 1] === CR ||
    (at === UTF8_BOM.length && buf.subarray(0, at).equals(UTF8_BOM));
  const v = at + PDF_MAGIC.length;
  return (
    lineStart &&
    buf[v] === DASH &&
    isDigit(buf[v + 1]) &&
    buf[v + 2] === DOT &&
    isDigit(buf[v + 3]) &&
    (buf[v + 4] === LF || buf[v + 4] === CR)
  );
}

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdfBuffer(buf: Buffer): boolean {
  return sniffWindow(buf).indexOf(PDF_MAGIC) !== -1;
}

/**
 * Byte offset of the PDF header line (`%PDF-1.7` on a line of its own)
 * starting within the first 1KB, or -1 when there is none. A body that
 * merely mentions the magic does not pass.
 */
export function pdfHeaderLineOffset(buf: Buffer): number {
  const window = sniffWindow(buf);
  for (
    let at = window.indexOf(PDF_MAGIC);
    at !== -1;
    at = window.indexOf(PDF_MAGIC, at + 1)
  ) {
    if (isHeaderLineAt(buf, at)) return at;
  }
  return -1;
}

/**
 * The buffer from its header line on; unchanged when the header is at byte
 * 0 or when no header line is found (so bytes that merely mention the magic
 * are never truncated).
 */
export function fromPdfHeader(buf: Buffer): Buffer {
  const offset = pdfHeaderLineOffset(buf);
  return offset > 0 ? buf.subarray(offset) : buf;
}
