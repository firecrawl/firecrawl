import { Meta } from "../..";
import escapeHtml from "escape-html";
import { PDFParse } from "pdf-parse";
import { readFile } from "node:fs/promises";
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
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const parser = new PDFParse({ data: bytes });
    try {
      // `first` caps extraction at the first `max` pages, and an empty
      // pageJoiner keeps the concatenated text free of the per-page markers
      // pdf-parse 2.x adds by default.
      let total: number;
      let pages: { text: string }[];
      try {
        const result = await parser.getText({ first: max, pageJoiner: "" });
        total = result.total;
        pages = result.pages;
      } catch (firstError) {
        // pdf-parse 1.x skipped a page that failed to render and kept the
        // rest; 2.x rejects the whole extraction. Retry page by page to
        // keep that tolerance.
        try {
          total = (await parser.getInfo()).total;
        } catch {
          throw firstError;
        }
        pages = [];
        for (let i = 1; i <= Math.min(total, max); i++) {
          try {
            const page = await parser.getText({
              partial: [i],
              pageJoiner: "",
            });
            pages.push({ text: page.pages[0]?.text ?? "" });
          } catch {
            pages.push({ text: "" });
          }
        }
      }
      const durationMs = Date.now() - startedAt;
      // pdf-parse 1.x prefixed every page's text with a blank line.
      const escaped = escapeHtml(
        pages.map(page => `\n\n${page.text}`).join(""),
      );

      meta.logger.info("pdfParse succeeded", {
        durationMs,
        markdownLength: escaped.length,
        numPages: total,
        ...(total > max ? { truncatedToPages: max } : {}),
      });

      return {
        markdown: escaped,
        html: escaped,
        pagesProcessed: Math.min(total, max),
        pageCount: total,
      };
    } finally {
      await parser.destroy();
    }
  } catch (error) {
    meta.logger.error("pdfParse failed", { error });
    throw error;
  }
}
