import type { Meta } from "../../..";
import { hasCustomRequestContext } from "../../../lib/request-context";

export function buildFirePdfRequestMetadata(meta: Meta): {
  source_endpoint: "scrape" | "parse";
  source_request_context: "default" | "custom";
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

  // Upload requests use synthetic URLs, and ZDR requests omit URL metadata.
  if (isParse || meta.internalOptions.zeroDataRetention === true) {
    return { source_endpoint, source_request_context };
  }

  return {
    source_endpoint,
    source_request_context,
    url: meta.rewrittenUrl ?? meta.url,
  };
}
