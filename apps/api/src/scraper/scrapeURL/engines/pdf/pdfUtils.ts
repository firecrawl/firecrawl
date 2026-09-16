import { createReadStream, createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export {
  fromPdfHeader,
  isPdfBuffer,
  pdfHeaderOffset,
  PDF_SNIFF_WINDOW,
} from "../../../../lib/pdf-format";

/**
 * Rewrites a file in place without its first `offset` bytes, so the %PDF
 * header lands at byte 0. Cross-reference offsets inside a PDF are relative
 * to the header, so stricter parsers reject a file whose header is not at
 * the start where a repairing reader would recover it. Streams the copy so
 * a large file never has to fit in memory; a failed copy leaves the
 * original untouched.
 */
export async function stripLeadingBytes(
  filePath: string,
  offset: number,
): Promise<void> {
  if (offset <= 0) return;
  const tmpPath = `${filePath}.strip`;
  try {
    await pipeline(
      createReadStream(filePath, { start: offset }),
      createWriteStream(tmpPath),
    );
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
