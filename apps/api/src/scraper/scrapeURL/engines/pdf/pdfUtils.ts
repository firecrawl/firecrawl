export const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdfBuffer(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, PDF_SNIFF_WINDOW));
  return window.includes(PDF_MAGIC);
}
