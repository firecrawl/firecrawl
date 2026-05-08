export const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdfBuffer(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, PDF_SNIFF_WINDOW));
  return window.includes(PDF_MAGIC);
}

/**
 * Given an HTML string, returns the first PDF URL found in an <iframe>,
 * <embed>, or <object> tag, or null if none is found.
 */
export function extractEmbeddedPdfUrl(
  html: string,
  baseUrl: string,
): string | null {
  // Match src/data attributes in <iframe>, <embed>, <object> tags
  const pattern =
    /<(?:iframe|embed|object)[^>]+(?:src|data)=["']([^"']+\.pdf(?:[?#][^"']*)?)["']/gi;
  const match = pattern.exec(html);
  if (!match) return null;

  const found = match[1];
  try {
    const resolved = new URL(found, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }
    return resolved.href;
  } catch {
    return null;
  }
}
