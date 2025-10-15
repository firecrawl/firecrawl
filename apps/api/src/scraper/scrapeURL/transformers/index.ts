import { parseMarkdown } from "../../../lib/html-to-markdown";
import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { htmlTransform } from "../lib/removeUnwantedElements";
import { extractLinks } from "../lib/extractLinks";
import { extractImages } from "../lib/extractImages";
import { extractMetadata } from "../lib/extractMetadata";
import { performLLMExtract, performSummary } from "./llmExtract";
import { uploadScreenshot } from "./uploadScreenshot";
import { removeBase64Images } from "./removeBase64Images";
import { performAgent } from "./agent";
import { performAttributes } from "./performAttributes";

import { deriveDiff } from "./diff";
import { useIndex, useSearchIndex } from "../../../services/index";
import { sendDocumentToIndex } from "../engines/index/index";
import { sendDocumentToSearchIndex } from "./sendToSearchIndex";
import {
  hasFormatOfType,
  hasAnyFormatOfTypes,
} from "../../../lib/format-utils";

type Transformer = (
  meta: Meta,
  document: Document,
) => Document | Promise<Document>;

async function deriveMetadataFromRawHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- this transformer is being called out of order",
    );
  }

  document.metadata = {
    ...(await extractMetadata(meta, document.rawHtml)),
    ...document.metadata,
  };
  return document;
}

async function deriveHTMLFromRawHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- this transformer is being called out of order",
    );
  }

  document.html = await htmlTransform(
    document.rawHtml,
    document.metadata.url ??
      document.metadata.sourceURL ??
      meta.rewrittenUrl ??
      meta.url,
    meta.options,
  );
  return document;
}

async function deriveMarkdownFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (document.html === undefined) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
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

  document.markdown = await parseMarkdown(document.html);

  if (
    meta.options.onlyMainContent === true &&
    (!document.markdown || document.markdown.trim().length === 0)
  ) {
    meta.logger.info(
      "Main content extraction resulted in empty markdown, falling back to full content extraction",
    );

    const fallbackMeta = {
      ...meta,
      options: {
        ...meta.options,
        onlyMainContent: false,
      },
    };

    document = await deriveHTMLFromRawHTML(fallbackMeta, document);
    document.markdown = await parseMarkdown(document.html);

    meta.logger.info("Fallback to full content extraction completed", {
      markdownLength: document.markdown?.length || 0,
    });
  }

  return document;
}

async function deriveLinksFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  // Only derive if the formats has links
  if (hasFormatOfType(meta.options.formats, "links")) {
    if (document.html === undefined) {
      throw new Error(
        "html is undefined -- this transformer is being called out of order",
      );
    }

    document.links = await extractLinks(
      document.html,
      document.metadata.url ??
        document.metadata.sourceURL ??
        meta.rewrittenUrl ??
        meta.url,
    );
  }

  return document;
}

async function deriveImagesFromHTML(
  meta: Meta,
  document: Document,
): Promise<Document> {
  // Only derive if the formats has images
  if (hasFormatOfType(meta.options.formats, "images")) {
    if (document.html === undefined) {
      throw new Error(
        "html is undefined -- this transformer is being called out of order",
      );
    }

    document.images = await extractImages(
      document.html,
      document.metadata.url ??
        document.metadata.sourceURL ??
        meta.rewrittenUrl ??
        meta.url,
    );
  }

  return document;
}

function coerceFieldsToFormats(meta: Meta, document: Document): Document {
  const hasMarkdown = hasFormatOfType(meta.options.formats, "markdown");
  const hasRawHtml = hasFormatOfType(meta.options.formats, "rawHtml");
  const hasHtml = hasFormatOfType(meta.options.formats, "html");
  const hasLinks = hasFormatOfType(meta.options.formats, "links");
  const hasImages = hasFormatOfType(meta.options.formats, "images");
  const hasChangeTracking = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  );
  const hasJson = hasFormatOfType(meta.options.formats, "json");
  const hasScreenshot = hasFormatOfType(meta.options.formats, "screenshot");
  const hasSummary = hasFormatOfType(meta.options.formats, "summary");

  if (!hasMarkdown && document.markdown !== undefined) {
    delete document.markdown;
  } else if (hasMarkdown && document.markdown === undefined) {
    meta.logger.warn(
      "Request had format: markdown, but there was no markdown field in the result.",
    );
  }

  if (!hasRawHtml && document.rawHtml !== undefined) {
    delete document.rawHtml;
  } else if (hasRawHtml && document.rawHtml === undefined) {
    meta.logger.warn(
      "Request had format: rawHtml, but there was no rawHtml field in the result.",
    );
  }

  if (!hasHtml && document.html !== undefined) {
    delete document.html;
  } else if (hasHtml && document.html === undefined) {
    meta.logger.warn(
      "Request had format: html, but there was no html field in the result.",
    );
  }

  if (!hasScreenshot && document.screenshot !== undefined) {
    meta.logger.warn(
      "Removed screenshot from Document because it wasn't in formats -- this is very wasteful and indicates a bug.",
    );
    delete document.screenshot;
  } else if (hasScreenshot && document.screenshot === undefined) {
    meta.logger.warn(
      "Request had format: screenshot / screenshot@fullPage, but there was no screenshot field in the result.",
    );
  }

  if (!hasLinks && document.links !== undefined) {
    meta.logger.warn(
      "Removed links from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.links;
  } else if (hasLinks && document.links === undefined) {
    meta.logger.warn(
      "Request had format: links, but there was no links field in the result.",
    );
  }

  if (!hasImages && document.images !== undefined) {
    meta.logger.warn(
      "Removed images from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
      { hasImages, hasImagesField: document.images !== undefined },
    );
    delete document.images;
  } else if (hasImages && document.images === undefined) {
    meta.logger.warn(
      "Request had format: images, but there was no images field in the result.",
      { hasImages, hasImagesField: document.images !== undefined },
    );
  }

  // Handle v1 backward compatibility - don't delete fields based on v1OriginalFormat
  const shouldKeepExtract = meta.internalOptions.v1OriginalFormat === "extract";
  const shouldKeepJson = meta.internalOptions.v1OriginalFormat === "json";

  // Debug logging for v1 format investigation
  if (meta.internalOptions.v1OriginalFormat) {
    meta.logger.debug("coerceFieldsToFormats v1 format debug", {
      v1OriginalFormat: meta.internalOptions.v1OriginalFormat,
      hasJson: !!hasJson,
      shouldKeepExtract,
      shouldKeepJson,
      hasExtractField: document.extract !== undefined,
      hasJsonField: document.json !== undefined,
    });
  }

  if (
    !hasJson &&
    (document.extract !== undefined || document.json !== undefined)
  ) {
    // For v1 API, keep the field specified by v1OriginalFormat
    if (!shouldKeepExtract && document.extract !== undefined) {
      meta.logger.warn(
        "Removed extract from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
      );
      delete document.extract;
    }
    if (!shouldKeepJson && document.json !== undefined) {
      meta.logger.warn(
        "Removed json from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
      );
      delete document.json;
    }
  } else if (
    hasJson &&
    document.extract === undefined &&
    document.json === undefined
  ) {
    meta.logger.warn(
      "Request had format json, but there was no json field in the result.",
    );
  }

  if (!hasSummary && document.summary !== undefined) {
    meta.logger.warn(
      "Removed summary from Document because it wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.summary;
  } else if (hasSummary && document.summary === undefined) {
    meta.logger.warn(
      "Request had format summary, but there was no summary field in the result.",
    );
  }

  if (!hasChangeTracking && document.changeTracking !== undefined) {
    meta.logger.warn(
      "Removed changeTracking from Document because it wasn't in formats -- this is extremely wasteful and indicates a bug.",
    );
    delete document.changeTracking;
  } else if (hasChangeTracking && document.changeTracking === undefined) {
    meta.logger.warn(
      "Request had format changeTracking, but there was no changeTracking field in the result.",
    );
  }

  if (
    document.changeTracking &&
    !hasChangeTracking?.modes?.includes("git-diff") &&
    document.changeTracking.diff !== undefined
  ) {
    meta.logger.warn(
      "Removed diff from changeTracking because git-diff mode wasn't specified in changeTrackingOptions.modes.",
    );
    delete document.changeTracking.diff;
  }

  if (
    document.changeTracking &&
    !hasChangeTracking?.modes?.includes("json") &&
    document.changeTracking.json !== undefined
  ) {
    meta.logger.warn(
      "Removed structured from changeTracking because structured mode wasn't specified in changeTrackingOptions.modes.",
    );
    delete document.changeTracking.json;
  }

  if (meta.options.actions === undefined || meta.options.actions.length === 0) {
    delete document.actions;
  }

  return document;
}

// TODO: allow some of these to run in parallel
const transformerStack: Transformer[] = [
  deriveHTMLFromRawHTML,
  deriveMarkdownFromHTML,
  deriveLinksFromHTML,
  deriveImagesFromHTML,
  deriveMetadataFromRawHTML,
  uploadScreenshot,
  ...(useIndex ? [sendDocumentToIndex] : []),
  ...(useSearchIndex ? [sendDocumentToSearchIndex] : []), // Add to search index for real-time search
  performLLMExtract,
  performSummary,
  performAttributes,
  performAgent,
  deriveDiff,
  coerceFieldsToFormats,
  removeBase64Images,
];

export async function executeTransformers(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const executions: [string, number][] = [];

  for (const transformer of transformerStack) {
    const _meta = {
      ...meta,
      logger: meta.logger.child({
        method: "executeTransformers/" + transformer.name,
      }),
    };
    const start = Date.now();
    document = await transformer(_meta, document);
    executions.push([transformer.name, Date.now() - start]);
  }

  meta.logger.debug("Executed transformers.", { executions });

  return document;
}
