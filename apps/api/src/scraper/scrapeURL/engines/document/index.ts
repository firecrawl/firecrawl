import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { fetchFileToBuffer } from "../utils/downloadFile";
import { DocumentConverter, DocumentType } from "@mendable/firecrawl-rs";
import type { Response } from "undici";
import { DocumentAntibotError, DocumentPrefetchFailed } from "../../error";
import { readFile, unlink } from "node:fs/promises";

const converter = new DocumentConverter();

function getDocumentTypeFromUrl(url: string): DocumentType {
  const urlLower = url.toLowerCase();

  // Check for extensions at the end or in the middle (e.g., file.xlsx/hash)
  if (urlLower.endsWith(".docx") || urlLower.includes(".docx/"))
    return DocumentType.Docx;
  if (urlLower.endsWith(".odt") || urlLower.includes(".odt/"))
    return DocumentType.Odt;
  if (urlLower.endsWith(".rtf") || urlLower.includes(".rtf/"))
    return DocumentType.Rtf;
  if (
    urlLower.endsWith(".xlsx") ||
    urlLower.endsWith(".xls") ||
    urlLower.includes(".xlsx/") ||
    urlLower.includes(".xls/")
  )
    return DocumentType.Xlsx;

  return DocumentType.Docx; // hope for the best
}

function getDocumentTypeFromContentType(
  contentType: string | null,
): DocumentType | null {
  if (!contentType) return null;

  const ct = contentType.toLowerCase();

  if (
    ct.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) ||
    ct.includes("application/msword")
  ) {
    return DocumentType.Docx;
  }

  if (ct.includes("application/vnd.oasis.opendocument.text")) {
    return DocumentType.Odt;
  }

  if (ct.includes("application/rtf") || ct.includes("text/rtf")) {
    return DocumentType.Rtf;
  }

  if (
    ct.includes(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ) ||
    ct.includes("application/vnd.ms-excel")
  ) {
    return DocumentType.Xlsx;
  }

  return null;
}

function isValidDocumentContentType(contentType: string | null): boolean {
  if (!contentType) return false;

  const ct = contentType.toLowerCase();
  const validTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/msword",
    "application/rtf",
    "text/rtf",
    "application/vnd.oasis.opendocument.text",
  ];

  return validTypes.some(type => ct.includes(type));
}

export async function scrapeDocument(meta: Meta): Promise<EngineScrapeResult> {
  let response: Response;
  let buffer: Buffer;
  let proxyUsed: "basic" | "stealth" = "basic";
  let tempFilePath: string | null = null;

  try {
    if (meta.documentPrefetch !== undefined && meta.documentPrefetch !== null) {
      // Use prefetched document
      tempFilePath = meta.documentPrefetch.filePath;
      buffer = await readFile(tempFilePath);

      // Create a mock response object with content-type from prefetch
      const headers = new Headers();
      if (meta.documentPrefetch.contentType) {
        headers.set("Content-Type", meta.documentPrefetch.contentType);
      }

      response = {
        url: meta.documentPrefetch.url ?? meta.rewrittenUrl ?? meta.url,
        status: meta.documentPrefetch.status,
        headers,
      } as Response;

      proxyUsed = meta.documentPrefetch.proxyUsed;
    } else {
      // Fetch the document normally
      const result = await fetchFileToBuffer(
        meta.rewrittenUrl ?? meta.url,
        meta.options.skipTlsVerification,
        {
          headers: meta.options.headers,
          signal: meta.abort.asSignal(),
        },
      );
      response = result.response;
      buffer = result.buffer;

      // Validate content type only when fetching directly (not using prefetch)
      const ct = response.headers.get("Content-Type");
      if (ct && !isValidDocumentContentType(ct)) {
        // if downloaded file wasn't a valid document, throw antibot error
        throw new DocumentAntibotError();
      }
    }

    const documentType =
      getDocumentTypeFromContentType(response.headers.get("content-type")) ??
      getDocumentTypeFromUrl(response.url);

    const html = await converter.convertBufferToHtml(
      new Uint8Array(buffer),
      documentType,
    );

    return {
      url: response.url,
      statusCode: response.status,
      html,
      contentType: response.headers.get("content-type") ?? undefined,
      proxyUsed,
    };
  } finally {
    // Clean up temporary file if it was created by prefetch
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (error) {
        // Ignore errors when cleaning up temp files
        meta.logger?.warn("Failed to clean up temporary document file", {
          error,
          tempFilePath,
        });
      }
    }
  }
}

export function documentMaxReasonableTime(meta: Meta): number {
  return 15000;
}
