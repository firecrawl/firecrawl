import { Meta } from "../..";
import escapeHtml from "escape-html";
import { PDFParse, type TextResult } from "pdf-parse";
import { readFile } from "node:fs/promises";
import type { PDFProcessorResult } from "./types";

export async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with parse-pdf", { tempFilePath });

  try {
    const startedAt = Date.now();
    const parser = new PDFParse({ data: await readFile(tempFilePath) });
    let result: TextResult;
    let durationMs: number;

    try {
      // pdf-parse v2 adds page markers by default; disable them to preserve
      // the plain page-joined text returned by v1.
      result = await parser.getText({ pageJoiner: "" });
      durationMs = Date.now() - startedAt;
    } finally {
      try {
        await parser.destroy();
      } catch (destroyError) {
        meta.logger.warn("pdfParse cleanup failed", { error: destroyError });
      }
    }

    const escaped = escapeHtml(result.text);

    meta.logger.info("pdfParse succeeded", {
      durationMs,
      markdownLength: escaped.length,
      numPages: result.total,
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
