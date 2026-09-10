import type { Meta } from "../../..";

export function buildFirePdfRequestMetadata(meta: Meta): {
  source_endpoint: "scrape" | "parse";
  url?: string;
} {
  const isParse =
    meta.internalOptions.isParse === true ||
    meta.internalOptions.uploadedFile !== undefined;
  const source_endpoint = isParse ? "parse" : "scrape";

  // Upload requests use synthetic URLs, and ZDR requests omit URL metadata.
  if (isParse || meta.internalOptions.zeroDataRetention === true) {
    return { source_endpoint };
  }

  return { source_endpoint, url: meta.rewrittenUrl ?? meta.url };
}
