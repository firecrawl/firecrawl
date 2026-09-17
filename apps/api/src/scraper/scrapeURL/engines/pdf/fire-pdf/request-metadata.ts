import type { Meta } from "../../..";
import { hasCustomRequestContext } from "../../../lib/request-context";

/** What we hand fire-pdf: a PDF, or a raster image wrapped as a one-page document. */
export type FirePdfSourceKind = "pdf" | "image";

export function buildFirePdfRequestMetadata(
  meta: Meta,
  sourceKind: FirePdfSourceKind = "pdf",
): {
  source_endpoint: "scrape" | "parse";
  source_request_context: "default" | "custom";
  source_kind: FirePdfSourceKind;
  url?: string;
} {
  const isParse =
    meta.internalOptions.isParse === true ||
    meta.internalOptions.uploadedFile !== undefined;
  const source_endpoint = isParse ? "parse" : "scrape";
  // Describe supplied request options without forwarding their values.
  const source_request_context = hasCustomRequestContext(meta.options)
    ? "custom"
    : "default";
  // fire-pdf labels its metrics and logs with this so image OCR traffic can
  // be measured — and, if needed, routed — separately from PDF parsing.
  const source_kind = sourceKind;

  // Upload requests use synthetic URLs, and ZDR requests omit URL metadata.
  if (isParse || meta.internalOptions.zeroDataRetention === true) {
    return { source_endpoint, source_request_context, source_kind };
  }

  return {
    source_endpoint,
    source_request_context,
    source_kind,
    url: meta.rewrittenUrl ?? meta.url,
  };
}
