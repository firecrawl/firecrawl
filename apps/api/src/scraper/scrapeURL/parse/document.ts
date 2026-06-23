import { DocumentConverter, DocumentType } from "@mendable/firecrawl-rs";
import type { Meta } from "../context";
import type { EngineScrapeResult, Fetched } from "../types";

const converter = new DocumentConverter();

function resolveDocumentType(contentType: string | undefined): DocumentType {
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.includes("openxmlformats-officedocument.wordprocessingml.document")) {
    return DocumentType.Docx;
  }
  if (ct.includes("openxmlformats-officedocument.spreadsheetml.sheet")) {
    return DocumentType.Xlsx;
  }
  if (ct.includes("application/vnd.ms-excel")) return DocumentType.Xlsx;
  if (ct.includes("application/msword")) return DocumentType.Doc;
  if (ct.includes("application/rtf") || ct.includes("text/rtf"))
    return DocumentType.Rtf;
  if (ct.includes("vnd.oasis.opendocument.text")) return DocumentType.Odt;
  throw new Error(
    `Unsupported document content-type: ${contentType ?? "<none>"}`,
  );
}

export async function parseDocumentBuffer(
  _meta: Meta,
  fetched: Fetched,
): Promise<EngineScrapeResult> {
  const contentType =
    fetched.contentType ??
    fetched.headers.find(h => h.name.toLowerCase() === "content-type")?.value;

  const html = await converter.convertBufferToHtml(
    new Uint8Array(fetched.buffer),
    resolveDocumentType(contentType),
  );

  return {
    url: fetched.url,
    statusCode: fetched.status,
    html,
    contentType,
    proxyUsed: fetched.proxyUsed ?? "basic",
  };
}
