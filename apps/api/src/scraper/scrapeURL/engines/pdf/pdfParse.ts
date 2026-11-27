import { Meta } from "../..";
import escapeHtml from "escape-html";
import { PDFParse } from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { PDFProcessorResult } from "./types";

// pdf-parse walks every page the file declares; a tiny file can declare
// billions. Cap the walk when the request sets no maxPages of its own.
export const PDF_PARSE_MAX_PAGES = 1000;

// Hard ceiling on the declared page count. pdf-parse's getText loops from
// page 1 to the declared total on every call, checking each page against
// the requested range, so even a capped extraction costs CPU proportional
// to the declared total. A document declaring more pages than this is
// rejected from its metadata, before any extraction call pays that loop.
export const PDF_PARSE_MAX_DECLARED_PAGES = 100_000;

// Pages per range attempt when bulk extraction fails and the code retries
// in ranges to isolate the bad pages.
const PDF_PARSE_FALLBACK_CHUNK_PAGES = 32;

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
      // Learn the declared page count before extracting: getInfo without
      // parsePageInfo never walks the pages, so an absurd declared count
      // can be rejected here instead of inside getText's page loop. The
      // guard fails closed: if the count cannot be read at all, extraction
      // is not attempted unbounded.
      const total = (await parser.getInfo()).total;
      if (total > PDF_PARSE_MAX_DECLARED_PAGES) {
        throw new Error(
          `PDF declares ${total} pages, exceeding the limit of ${PDF_PARSE_MAX_DECLARED_PAGES}`,
        );
      }

      let pages: { text: string }[];
      let pagesProcessed: number;
      let skippedPages = 0;
      try {
        // `first` caps extraction at the first `max` pages, and an empty
        // pageJoiner keeps the concatenated text free of the per-page
        // markers pdf-parse 2.x adds by default.
        const result = await parser.getText({ first: max, pageJoiner: "" });
        pages = result.pages;
        pagesProcessed = Math.min(total, max);
      } catch (firstError) {
        // pdf-parse 1.x skipped a page that failed to render and kept the
        // rest; 2.x rejects the whole extraction. Retry in page ranges to
        // keep that tolerance: a range that succeeds costs one call, and a
        // range that fails is narrowed page by page only within itself, so
        // each page in a failed range gets a second attempt on its own.
        const cappedTotal = Math.min(total, max);
        pages = Array.from({ length: cappedTotal }, () => ({ text: "" }));
        let succeededPages = 0;
        for (
          let chunkStart = 1;
          chunkStart <= cappedTotal;
          chunkStart += PDF_PARSE_FALLBACK_CHUNK_PAGES
        ) {
          const chunkEnd = Math.min(
            chunkStart + PDF_PARSE_FALLBACK_CHUNK_PAGES - 1,
            cappedTotal,
          );
          try {
            const chunk = await parser.getText({
              first: chunkStart,
              last: chunkEnd,
              pageJoiner: "",
            });
            for (const page of chunk.pages) {
              pages[page.num - 1] = { text: page.text };
            }
            succeededPages += chunk.pages.length;
            continue;
          } catch {
            // Narrow this range page by page below.
          }
          for (let i = chunkStart; i <= chunkEnd; i++) {
            try {
              const page = await parser.getText({
                first: i,
                last: i,
                pageJoiner: "",
              });
              pages[i - 1] = { text: page.pages[0]?.text ?? "" };
              succeededPages++;
            } catch (pageError) {
              skippedPages++;
              meta.logger.warn(
                "pdfParse skipped a page that failed to extract",
                {
                  page: i,
                  error: pageError,
                },
              );
            }
          }
        }
        // No page could be extracted at all: this is a failed scrape, not
        // an empty successful one, so the engine can fall back.
        if (succeededPages === 0) {
          throw firstError;
        }
        pagesProcessed = succeededPages;
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
        ...(skippedPages > 0 ? { skippedPages } : {}),
      });

      return {
        markdown: escaped,
        html: escaped,
        pagesProcessed,
        pageCount: total,
      };
    } finally {
      // Cleanup must never replace a successful result or mask the error
      // that actually failed the extraction.
      try {
        await parser.destroy();
      } catch (destroyError) {
        meta.logger.warn("pdfParse failed to destroy the parser", {
          error: destroyError,
        });
      }
    }
  } catch (error) {
    meta.logger.error("pdfParse failed", { error });
    throw error;
  }
}
