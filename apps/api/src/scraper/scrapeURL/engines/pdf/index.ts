import { Meta } from "../..";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { downloadFile, fetchFileToBuffer } from "../utils/downloadFile";
import { safeMarkdownToHtml } from "./markdownToHtml";
import {
  PDFAntibotError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  PDFPrefetchFailed,
  RemoveFeatureError,
  EngineUnsuccessfulError,
} from "../../error";
import { open, readFile, unlink } from "node:fs/promises";
import { AbortManagerThrownError } from "../../lib/abortManager";
import {
  shouldParsePDF,
  getPDFMaxPages,
  getPDFMode,
} from "../../../../controllers/v2/types";
import type { PDFMode } from "../../../../controllers/v2/types";
import { processPdf, detectPdf } from "@mendable/firecrawl-rs";
import {
  FIRE_PDF_MAX_FILE_SIZE,
  MAX_FILE_SIZE,
  MILLISECONDS_PER_PAGE,
} from "./types";
import type { PDFProcessorResult } from "./types";
import {
  emitNativeLogs,
  extractAndEmitNativeLogs,
} from "../../../../lib/native-logging";
import { withSpan, setSpanAttributes } from "../../../../lib/otel-tracer";
import { scrapePDFWithRunPodMU } from "./runpodMU";
import { scrapePDFWithFirePDF } from "./firePDF";
import { scrapePDFWithParsePDF } from "./pdfParse";
import { captureExceptionWithZdrCheck } from "../../../../services/sentry";
import { isPdfBuffer, PDF_SNIFF_WINDOW } from "./pdfUtils";
import { comparePdfOutputs } from "./shadowComparison";

/** Check if the PDF is eligible for Rust extraction, returning a rejection reason or null. */
function getIneligibleReason(
  result: ReturnType<typeof processPdf>,
): string | null {
  if (result.pdfType !== "TextBased") return `pdfType=${result.pdfType}`;
  if (result.confidence < 0.95) return `confidence=${result.confidence}`;
  if (result.isComplex) return "complex layout (tables/columns)";
  if (!result.markdown?.length)
    return "empty markdown (unexpected for TextBased)";
  return null;
}

export async function scrapePDF(meta: Meta): Promise<EngineScrapeResult> {
  const shouldParse = shouldParsePDF(meta.options.parsers);
  const maxPages = getPDFMaxPages(meta.options.parsers);
  const mode: PDFMode = getPDFMode(meta.options.parsers);

  // DEFENSIVE SNIFFING: If it's HTML masquerading as a PDF, return unsuccessful to trigger fallback
  if (!shouldParse && meta.pdfPrefetch?.contentType?.includes("text/html")) {
      throw new EngineUnsuccessfulError("pdf (html-detected)");
  }

  if (!shouldParse) {
    if (meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null) {
      const content = (await readFile(meta.pdfPrefetch.filePath)).toString(
        "base64",
      );
      return {
        url: meta.pdfPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        statusCode: meta.pdfPrefetch.status,

        html: content,
        markdown: content,

        contentType: "application/pdf",
        proxyUsed: meta.pdfPrefetch.proxyUsed,
      };
    } else {
      const file = await fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
      );
      
      // Defensive sniffing
      if (file.response.headers.get("content-type")?.includes("text/html")) {
          throw new EngineUnsuccessfulError("pdf (html-detected)");
      }

      if (!isPdfBuffer(file.buffer)) {
        // downloaded content isn't a valid PDF
        if (meta.pdfPrefetch === undefined) {
          // for non-PDF URLs, this is expected, not anti-bot
          if (!meta.featureFlags.has("pdf")) {
            throw new EngineUnsuccessfulError("pdf");
          } else {
            throw new PDFAntibotError();
          }
        } else {
          throw new PDFPrefetchFailed();
        }
      }

      const content = file.buffer.toString("base64");
      return {
        url: file.response.url,
        statusCode: file.response.status,

        html: content,
        markdown: content,

        contentType: "application/pdf",
        proxyUsed: "basic",
      };
    }
  }

  const { response, tempFilePath } =
    meta.pdfPrefetch !== undefined && meta.pdfPrefetch !== null
      ? { response: meta.pdfPrefetch, tempFilePath: meta.pdfPrefetch.filePath }
      : await downloadFile(
          meta.id,
          meta.rewrittenUrl ?? meta.url,
          meta.options.skipTlsVerification,
          {
            headers: meta.options.headers,
            signal: meta.abort.asSignal(),
          },
        );

  try {
    // Validate the downloaded file is actually a PDF by checking magic bytes
    const header = Buffer.alloc(PDF_SNIFF_WINDOW);
    const fh = await open(tempFilePath, "r");
    let headerBytesRead: number;
    try {
      ({ bytesRead: headerBytesRead } = await fh.read(
        header,
        0,
        PDF_SNIFF_WINDOW,
        0,
      ));
    } finally {
      await fh.close();
    }

    if (!isPdfBuffer(header.subarray(0, headerBytesRead))) {
      // Check content-type header as a fallback
      if (typeof response !== 'string' && (response as any).headers?.get?.("content-type")?.includes("text/html")) {
          throw new EngineUnsuccessfulError("pdf (html-detected)");
      }
      if (meta.pdfPrefetch === undefined) {
        if (!meta.featureFlags.has("pdf")) {
          throw new EngineUnsuccessfulError("pdf");
        } else {
          throw new PDFAntibotError();
        }
      } else {
        throw new PDFPrefetchFailed();
      }
    }
    // ... (rest of the file remains same)
