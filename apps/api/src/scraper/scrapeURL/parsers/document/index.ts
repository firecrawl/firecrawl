import path from "node:path";
import { Document } from "../../../../controllers/v2/types";
import { EngineScrapeResult } from "../../engines/types";
import { getEngineResultFile } from "../../lib/engine-result-file";
import {
  isDocumentContentType,
  isProbablyDocumentBase64,
} from "../../lib/file-format-check";
import { Meta } from "../../lib/meta";
import { parseHTML } from "../html";
import { DocumentConverter, DocumentType } from "@mendable/firecrawl-rs";

const converter = new DocumentConverter();

const DOCUMENT_EXTENSIONS = new Set([
  ".docx",
  ".doc",
  ".odt",
  ".rtf",
  ".xlsx",
  ".xls",
]);

export function canParseDocument(
  filename: string,
  contentType?: string | null,
): boolean {
  return (
    DOCUMENT_EXTENSIONS.has(path.extname(filename).toLowerCase()) ||
    isDocumentContentType(contentType)
  );
}

function getDocumentTypeFromUrl(url: string): DocumentType {
  const urlLower = url.toLowerCase();

  if (urlLower.endsWith(".docx") || urlLower.includes(".docx/")) {
    return DocumentType.Docx;
  }
  if (urlLower.endsWith(".doc") || urlLower.includes(".doc/")) {
    return DocumentType.Doc;
  }
  if (urlLower.endsWith(".odt") || urlLower.includes(".odt/")) {
    return DocumentType.Odt;
  }
  if (urlLower.endsWith(".rtf") || urlLower.includes(".rtf/")) {
    return DocumentType.Rtf;
  }
  if (
    urlLower.endsWith(".xlsx") ||
    urlLower.endsWith(".xls") ||
    urlLower.includes(".xlsx/") ||
    urlLower.includes(".xls/")
  ) {
    return DocumentType.Xlsx;
  }

  return DocumentType.Docx;
}

function getDocumentTypeFromContentType(
  contentType: string | null | undefined,
): DocumentType | null {
  if (!contentType) return null;

  const ct = contentType.toLowerCase();

  if (
    ct.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
  ) {
    return DocumentType.Docx;
  }

  if (ct.includes("application/msword")) {
    return DocumentType.Doc;
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

function getContentTypeFromDocumentType(documentType: DocumentType): string {
  switch (documentType) {
    case DocumentType.Docx:
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case DocumentType.Doc:
      return "application/msword";
    case DocumentType.Odt:
      return "application/vnd.oasis.opendocument.text";
    case DocumentType.Rtf:
      return "application/rtf";
    case DocumentType.Xlsx:
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
}

function getDocumentContent(result: EngineScrapeResult): string | undefined {
  const file = getEngineResultFile(result);
  if (file?.content) {
    return file.content;
  }

  if (isProbablyDocumentBase64(result.html)) {
    return result.html;
  }

  return undefined;
}

function getDocumentName(result: EngineScrapeResult): string {
  return getEngineResultFile(result)?.name ?? result.url;
}

export async function parseDocument(
  meta: Meta,
  result: EngineScrapeResult,
): Promise<Document> {
  const content = getDocumentContent(result);
  if (!content) {
    return parseHTML(meta, result);
  }

  const documentType =
    getDocumentTypeFromContentType(result.contentType) ??
    getDocumentTypeFromUrl(getDocumentName(result));

  const html = await converter.convertBufferToHtml(
    new Uint8Array(Buffer.from(content, "base64")),
    documentType,
  );

  return parseHTML(meta, {
    ...result,
    html,
    markdown: undefined,
    contentType:
      result.contentType ?? getContentTypeFromDocumentType(documentType),
  });
}
