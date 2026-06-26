import { Document } from "../../../controllers/v2/types";
import { EngineScrapeResult } from "../engines/types";
import { Meta } from "../lib/meta";

export function parseHTML(meta: Meta, result: EngineScrapeResult): Document {
  return {
    markdown: result.markdown,
    rawHtml: result.html,
    screenshot: result.screenshot,
    actions: result.actions,
    branding: result.branding,
    metadata: {
      sourceURL: meta.internalOptions.unnormalizedSourceURL ?? meta.url,
      url: result.url,
      statusCode: result.statusCode,
      error: result.error,
      numPages: result.pdfMetadata?.numPages,
      ...(result.pdfMetadata?.title ? { title: result.pdfMetadata.title } : {}),
      contentType: result.contentType,
      timezone: result.timezone,
      proxyUsed: result.proxyUsed ?? "basic",
      postprocessorsUsed: result.postprocessorsUsed,
    },
  };
}
