import { Meta } from "../..";
import escapeHtml from "escape-html";
import { readFile } from "node:fs/promises";
import type { PDFProcessorResult } from "./types";

type TextItemLike = { str: string; transform: number[] };
type TextMarkedContentLike = { type: string };

function isTextItem(
  item: TextItemLike | TextMarkedContentLike,
): item is TextItemLike {
  return typeof (item as TextItemLike).str === "string";
}

async function extractTextFromBuffer(
  buffer: Buffer,
): Promise<{ text: string; numPages: number }> {
  // pdfjs-dist is ESM-only; dynamic import works from both CJS and ESM call sites.
  // The legacy build avoids hard requirements on browser globals like DOMMatrix.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // pdfjs-dist mutates / detaches the buffer it's given. Pass an owned copy so
  // we don't disturb anything else holding the same Buffer.
  const data = new Uint8Array(buffer);

  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    // Errors-only — silences the polyfill / font-data warnings pdfjs prints
    // when it can't find @napi-rs/canvas or the standardFontDataUrl. Neither
    // affects text extraction, which is all we need here.
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  try {
    const numPages = doc.numPages;
    let text = "";

    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        let lastY: number | undefined;
        let pageText = "";
        for (const rawItem of content.items) {
          const item = rawItem as TextItemLike | TextMarkedContentLike;
          if (!isTextItem(item)) continue;
          const y = item.transform[5];
          if (lastY === undefined || lastY === y) {
            pageText += item.str;
          } else {
            pageText += "\n" + item.str;
          }
          lastY = y;
        }
        text += `\n\n${pageText}`;
      } finally {
        page.cleanup();
      }
    }

    return { text, numPages };
  } finally {
    await doc.destroy();
  }
}

export async function scrapePDFWithParsePDF(
  meta: Meta,
  tempFilePath: string,
): Promise<PDFProcessorResult> {
  meta.logger.debug("Processing PDF document with parse-pdf", { tempFilePath });

  try {
    const startedAt = Date.now();
    const { text, numPages } = await extractTextFromBuffer(
      await readFile(tempFilePath),
    );
    const durationMs = Date.now() - startedAt;
    const escaped = escapeHtml(text);

    meta.logger.info("pdfParse succeeded", {
      durationMs,
      markdownLength: escaped.length,
      numPages,
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
