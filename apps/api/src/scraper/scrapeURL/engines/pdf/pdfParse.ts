import type { Meta } from "../..";
import escapeHtml from "escape-html";
import PdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { LogMeta } from "../../../../lib/json-types";
import type { PDFProcessorResult } from "./types";

// pdf-parse walks every page the file declares; a tiny file can declare
// billions. Cap the walk when the request sets no maxPages of its own.
export const PDF_PARSE_MAX_PAGES = 1000;

export async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
  maxPages?: number,
): Promise<PDFProcessorResult> {
  const max = maxPages ?? PDF_PARSE_MAX_PAGES;
  meta.logger.debug("Processing PDF document with parse-pdf", {
    tempFilePath,
    maxPages: max,
  });

  try {
    const startedAt = Date.now();
    const file = await readFile(tempFilePath);
    // pdf-parse's bundled pdf.js (1.10) clones its input with
    // `new value.constructor(value)`. For a Buffer that is `new Buffer(...)`,
    // which Node serves from its shared 8 KiB pool for anything under 4 KiB,
    // so the clone is a slice with a non-zero byteOffset and pdf.js then
    // reads `bytes.buffer` at absolute offsets (Stream.makeSubStream). Every
    // PDF under ~4 KiB therefore failed with "bad XRef entry" unless the slice
    // happened to land at the start of a fresh pool. A Uint8Array view over
    // the same memory (no copy) turns that clone into `new Uint8Array(...)`,
    // which owns its ArrayBuffer.
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const result = await PdfParse(bytes, { max });
    const durationMs = Date.now() - startedAt;
    const escaped = escapeHtml(result.text);

    const logFields: LogMeta = {
      durationMs,
      markdownLength: escaped.length,
      numPages: result.numpages,
    };
    if (result.numpages > max) {
      logFields.truncatedToPages = max;
    }
    meta.logger.info("pdfParse succeeded", logFields);

    return {
      markdown: escaped,
      html: escaped,
      pagesProcessed: Math.min(result.numpages, max),
      pageCount: result.numpages,
    };
  } catch (error: unknown) {
    meta.logger.error("pdfParse failed", { error });
    throw error;
  }
}
