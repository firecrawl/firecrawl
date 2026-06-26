import { Document } from "../../../controllers/v2/types";
import { EngineScrapeResult } from "../engines/types";
import {
  isDocumentContentType,
  isPdfContentType,
  isProbablyDocumentBase64,
  isProbablyPdfBase64,
} from "../lib/file-format-check";
import { getEngineResultFile } from "../lib/engine-result-file";
import { Meta } from "../lib/meta";
import { canParseDocument, parseDocument } from "./document";
import { parseHTML } from "./html";
import { parsePDF } from "./pdf";

function hasPdfSignal(result: EngineScrapeResult): boolean {
  const file = getEngineResultFile(result);
  return (
    isPdfContentType(result.contentType) ||
    isProbablyPdfBase64(file?.content ?? result.html) ||
    file?.name?.toLowerCase().endsWith(".pdf") === true
  );
}

function hasDocumentSignal(result: EngineScrapeResult): boolean {
  const file = getEngineResultFile(result);
  return (
    isDocumentContentType(result.contentType) ||
    isProbablyDocumentBase64(file?.content ?? result.html) ||
    (file?.name !== undefined &&
      canParseDocument(file.name, result.contentType))
  );
}

export async function parseEngineResult(
  meta: Meta,
  result: EngineScrapeResult,
): Promise<Document> {
  if (hasPdfSignal(result)) {
    return parsePDF(meta, result);
  }

  if (hasDocumentSignal(result)) {
    return parseDocument(meta, result);
  }

  return parseHTML(meta, result);
}
