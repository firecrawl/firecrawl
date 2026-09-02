import { Meta } from "../..";
import escapeHtml from "escape-html";
import PdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { PDFProcessorResult } from "./types";

export async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with parse-pdf", { tempFilePath });

  try {
    const startedAt = Date.now();
    const file = await readFile(tempFilePath);
    // pdf-parse's bundled pdf.js (1.10) clones its input with
    // `new value.constructor(value)`. For a Buffer that is `new Buffer(...)`,
    // which Node serves from its shared 8 KiB pool for anything under 4 KiB,
    // so the clone is a slice with a non-zero byteOffset — and pdf.js then
    // reads `bytes.buffer` at absolute offsets (Stream.makeSubStream). Every
    // PDF under ~4 KiB therefore failed with "bad XRef entry" unless the slice
    // happened to land at the start of a fresh pool. A Uint8Array view over
    // the same memory (no copy) turns that clone into `new Uint8Array(...)`,
    // which owns its ArrayBuffer. (@types/pdf-parse declares Buffer, but
    // pdf.js accepts any Uint8Array.)
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const result = await PdfParse(bytes as Buffer);
    const durationMs = Date.now() - startedAt;
    const escaped = escapeHtml(result.text);

    meta.logger.info("pdfParse succeeded", {
      durationMs,
      markdownLength: escaped.length,
      numPages: result.numpages,
    });

    return {
      markdown: escaped,
      html: escaped,
    };
  } catch (error) {
    meta.logger.error("pdfParse failed", { error });
    throw error;
  }
}
