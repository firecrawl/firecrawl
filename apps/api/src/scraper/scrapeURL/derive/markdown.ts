import { parseMarkdown } from "../../../lib/html-to-markdown";
import type { Meta } from "../context";
import type { Document } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { deriveHTMLFromRawHTML } from "./html";

export async function deriveMarkdownFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  const needsMarkdown =
    !!hasFormatOfType(meta.options.formats, "markdown") ||
    !!hasFormatOfType(meta.options.formats, "changeTracking") ||
    !!hasFormatOfType(meta.options.formats, "json") ||
    !!hasFormatOfType(meta.options.formats, "summary") ||
    !!hasFormatOfType(meta.options.formats, "query") ||
    !!meta.options.onlyCleanContent;
  if (!needsMarkdown) return document;

  if (document.metadata.postprocessorsUsed?.length && document.markdown) {
    meta.logger.debug(
      "Skipping markdown derivation - postprocessor already set markdown",
      { postprocessorsUsed: document.metadata.postprocessorsUsed },
    );
    return document;
  }

  if (document.metadata.contentType?.includes("application/json")) {
    if (document.rawHtml === undefined) {
      throw new Error(
        "rawHtml is undefined -- this transformer is being called out of order",
      );
    }
    document.markdown = "```json\n" + document.rawHtml + "\n```";
    return document;
  }

  const requestId = meta.id || meta.internalOptions.crawlId;
  document.markdown = await parseMarkdown(document.html, {
    logger: meta.logger,
    requestId,
  });

  if (
    meta.options.onlyMainContent === true &&
    (!document.markdown || document.markdown.trim().length === 0)
  ) {
    meta.logger.info(
      "Main content extraction resulted in empty markdown, falling back to full content extraction",
    );
    const fallbackMeta: Meta = {
      ...meta,
      options: { ...meta.options, onlyMainContent: false },
    };
    document = await deriveHTMLFromRawHTML(fallbackMeta, document);
    document.markdown = await parseMarkdown(document.html, {
      logger: meta.logger,
      requestId,
    });
    meta.logger.info("Fallback to full content extraction completed", {
      markdownLength: document.markdown?.length || 0,
    });
  }

  return document;
}
