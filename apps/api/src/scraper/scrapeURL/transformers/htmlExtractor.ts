import { extract } from "@firecrawl/html-extractor";
import { Meta } from "..";
import { config } from "../../../config";
import { Document } from "../../../controllers/v2/types";

export async function performHtmlExtractor(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const live =
    config.FIRECRAWL_USE_HTML_EXTRACTOR === true ||
    meta.internalOptions.useHtmlExtractor === true ||
    meta.options.__experimental_htmlExtractor === true;
  const shadow =
    !live &&
    config.FIRECRAWL_HTML_EXTRACTOR_SHADOW_PERCENT > 0 &&
    Math.random() * 100 < config.FIRECRAWL_HTML_EXTRACTOR_SHADOW_PERCENT;

  if (!live && !shadow) return document;
  if (document.rawHtml === undefined) return document;

  const url =
    document.metadata.url ??
    document.metadata.sourceURL ??
    meta.rewrittenUrl ??
    meta.url;

  const start = Date.now();
  let result: Awaited<ReturnType<typeof extract>>;
  try {
    result = await extract(document.rawHtml, { url });
  } catch (err) {
    meta.logger.warn("html-extractor failed; falling back", {
      module: "html-extractor",
      mode: live ? "live" : "shadow",
      error: err instanceof Error ? err.message : String(err),
    });
    return document;
  }
  const durationMs = Date.now() - start;

  if (live) {
    document.markdown = result.markdown;
    document.extractionQuality = result.extractionQuality;
    document.pageType = result.pageType;
    meta.logger.info("html-extractor live", {
      module: "html-extractor",
      mode: "live",
      rawHtmlBytes: document.rawHtml.length,
      markdownBytes: result.markdown.length,
      pageType: result.pageType,
      extractionQuality: result.extractionQuality,
      durationMs,
    });
  } else {
    const legacyBytes = document.markdown?.length ?? 0;
    meta.logger.info("html-extractor shadow", {
      module: "html-extractor",
      mode: "shadow",
      rawHtmlBytes: document.rawHtml.length,
      legacyMarkdownBytes: legacyBytes,
      newMarkdownBytes: result.markdown.length,
      sizeRatio: legacyBytes > 0 ? result.markdown.length / legacyBytes : null,
      pageType: result.pageType,
      extractionQuality: result.extractionQuality,
      durationMs,
    });
  }

  return document;
}
