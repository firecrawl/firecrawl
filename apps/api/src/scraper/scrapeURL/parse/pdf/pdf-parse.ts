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
    const result = await PdfParse(await readFile(tempFilePath));
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
