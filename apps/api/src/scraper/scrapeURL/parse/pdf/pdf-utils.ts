import type { Fetched } from "../../types";

const PDF_SNIFF_WINDOW = 1024;

const PDF_MAGIC = Buffer.from("%PDF");

/** Check if a buffer contains the %PDF magic bytes within the first 1KB. */
export function isPdf(fetched: Fetched): boolean {
  const window = fetched.buffer.subarray(
    0,
    Math.min(fetched.buffer.length, PDF_SNIFF_WINDOW),
  );
  return window.includes(PDF_MAGIC);
}
