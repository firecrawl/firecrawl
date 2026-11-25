import { parseMarkdown } from "../../../lib/html-to-markdown";
import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { htmlTransform } from "../lib/removeUnwantedElements";
import { extractLinks } from "../lib/extractLinks";
import { isMarkdownContentType } from "../lib/extractLinksFromMarkdown";
import { extractImages } from "../lib/extractImages";
import { extractMetadata } from "../lib/extractMetadata";
import {
  performLLMExtract,
  performSummary,
  performCleanContent,
} from "./llmExtract";
import { performQuery } from "./query";
import { removeBase64Images } from "./removeBase64Images";
import { performAttributes } from "./performAttributes";
import { performPromptInjectionGuard } from "./promptInjectionGuard";
import { hasFormatOfType } from "../../../lib/format-utils";
import { scrapeHooks, toScrapeMeta } from "../hooks";

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

  const targetUrl =
    document.metadata.url ??
    document.metadata.sourceURL ??
    meta.rewrittenUrl ??
    meta.url;

  const hooks = scrapeHooks();
  if (hooks?.has("scrape.html.clean")) {
    const cleaning = await hooks.transform(
      "scrape.html.clean",
      {
        url: targetUrl,
        includeTags: (meta.options.includeTags ?? [])
          .map(x => x.trim())
          .filter(x => x.length !== 0),
        excludeTags: (meta.options.excludeTags ?? [])
          .map(x => x.trim())
          .filter(x => x.length !== 0),
        onlyMainContent: meta.options.onlyMainContent,
      },
      toScrapeMeta(meta),
    );
    document.html = await htmlTransform(
      document.rawHtml,
      cleaning.url,
      {
        ...meta.options,
        includeTags: cleaning.includeTags,
        excludeTags: cleaning.excludeTags,
        onlyMainContent: cleaning.onlyMainContent,
      },
      cleaning.dropSignatures,
    );
    return document;
  }

  document.html = await htmlTransform(
    document.rawHtml,
    targetUrl,
    meta.options,
  );
  return document;
}

function requireRawHtml(document: Document): string {
  if (document.rawHtml === undefined) {
    throw new Error(
      "rawHtml is undefined -- this transformer is being called out of order",
    );
  }
  return document.rawHtml;
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

  const hasMarkdown = hasFormatOfType(meta.options.formats, "markdown");
  const hasJson = hasFormatOfType(meta.options.formats, "json");
  const hasSummary = hasFormatOfType(meta.options.formats, "summary");
  const hasQuestion = hasFormatOfType(meta.options.formats, "question");
  const hasQuery = hasFormatOfType(meta.options.formats, "query");
  if (
    !meta.needsMarkdown &&
    !hasMarkdown &&
    !hasJson &&
    !hasSummary &&
    !hasQuestion &&
    !hasQuery &&
    !meta.options.checkPromptInjection &&
    !meta.options.onlyCleanContent
  ) {
    return document;
  }

  // Skip markdown derivation if the engine or a postprocessor already set it.
  if (document.markdown !== undefined) {
    meta.logger.debug(
      "Skipping markdown derivation - document already has markdown",
      { postprocessorsUsed: document.metadata.postprocessorsUsed },
    );
    return document;
  }

  // Media types are case-insensitive per RFC, so normalize before matching.
  const contentType = document.metadata.contentType?.toLowerCase();

  if (contentType?.includes("application/json")) {
    document.markdown = "```json\n" + requireRawHtml(document) + "\n```";
    return document;
  }

  // text/plain responses (e.g. llms.txt) are already plain text/markdown.
  // Running them through the HTML-to-markdown converter escapes markdown
  // punctuation like "_", which corrupts underscores inside link URLs. Pass
  // the raw body through untouched instead.
  if (contentType?.includes("text/plain")) {
    document.markdown = requireRawHtml(document);
    return document;
  }

  // Use scrape ID or crawl ID as request_id for tracing
  const requestId = meta.id || meta.internalOptions.crawlId;
  document.markdown = await parseMarkdown(document.html, {
    logger: meta.logger,
    requestId,
    zeroDataRetention: meta.internalOptions.zeroDataRetention,
  });

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
    document.markdown = await parseMarkdown(document.html, {
      logger: meta.logger,
      requestId,
      zeroDataRetention: meta.internalOptions.zeroDataRetention,
    });

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
  const isMarkdown = isMarkdownContentType(document.metadata.contentType);

  if (document.html === undefined && !isMarkdown) {
    throw new Error(
      "html is undefined -- this transformer is being called out of order",
    );
  }

  const requiresLinks = !!hasFormatOfType(meta.options.formats, "links");

  if (!requiresLinks) {
    return document;
  }

  // Engines that carry markdown natively (exchange) put synthetic metadata in
  // rawHtml, so the markdown field is the only place their links live.
  document.links = await extractLinks(
    isMarkdown ? (document.markdown ?? document.rawHtml ?? "") : document.html!,
    document.metadata.url ??
      document.metadata.sourceURL ??
      meta.rewrittenUrl ??
      meta.url,
    document.metadata.contentType,
  );

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
  const hasRawBase64 = hasFormatOfType(meta.options.formats, "rawBase64");
  const hasHtml = hasFormatOfType(meta.options.formats, "html");
  const hasLinks = hasFormatOfType(meta.options.formats, "links");
  const hasImages = hasFormatOfType(meta.options.formats, "images");
  const hasJson = hasFormatOfType(meta.options.formats, "json");
  const hasScreenshot = hasFormatOfType(meta.options.formats, "screenshot");
  const hasSummary = hasFormatOfType(meta.options.formats, "summary");
  const hasQuestionFormat = hasFormatOfType(meta.options.formats, "question");
  const hasLegacyQueryFormat = hasFormatOfType(meta.options.formats, "query");
  const hasAnswerFormat = hasQuestionFormat || hasLegacyQueryFormat;

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

  if (!hasRawBase64 && document.rawBase64 !== undefined) {
    delete document.rawBase64;
  } else if (hasRawBase64 && document.rawBase64 === undefined) {
    meta.logger.warn(
      "Request had format: rawBase64, but there was no rawBase64 field in the result.",
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

  const keepJson = !!hasJson || meta.keepDocumentFields?.has("json") === true;
  if (
    !keepJson &&
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

  if (!hasAnswerFormat && document.answer !== undefined) {
    meta.logger.warn(
      "Removed answer from Document because question/query wasn't in formats -- this is wasteful and indicates a bug.",
    );
    delete document.answer;
  } else if (hasAnswerFormat && document.answer === undefined) {
    meta.logger.warn(
      "Request had format question/query, but there was no answer field in the result.",
    );
  }

  if (meta.options.actions === undefined || meta.options.actions.length === 0) {
    delete document.actions;
  } else if (document.actions) {
    // Check if all action arrays are empty
    const hasScreenshots =
      document.actions.screenshots && document.actions.screenshots.length > 0;
    const hasScrapes =
      document.actions.scrapes && document.actions.scrapes.length > 0;
    const hasJsReturns =
      document.actions.javascriptReturns &&
      document.actions.javascriptReturns.length > 0;
    const hasPdfs = document.actions.pdfs && document.actions.pdfs.length > 0;

    if (!hasScreenshots && !hasScrapes && !hasJsReturns && !hasPdfs) {
      delete document.actions;
    }
  }

  return document;
}

type DocumentHookName =
  | "scrape.document.markdown"
  | "scrape.document.derived"
  | "scrape.document.extracted"
  | "scrape.document.final";

type TransformerStep = Transformer | { hook: DocumentHookName };

// TODO: allow some of these to run in parallel
const transformerStack: TransformerStep[] = [
  deriveHTMLFromRawHTML,
  deriveMarkdownFromHTML,
  performCleanContent,
  { hook: "scrape.document.markdown" },
  performPromptInjectionGuard,
  deriveLinksFromHTML,
  deriveImagesFromHTML,
  deriveMetadataFromRawHTML,
  { hook: "scrape.document.derived" },
  performLLMExtract,
  performSummary,
  performQuery,
  performAttributes,
  { hook: "scrape.document.extracted" },
  removeBase64Images,
  { hook: "scrape.document.final" },
  coerceFieldsToFormats,
];

export async function executeTransformers(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (meta.internalOptions.teamId === "sitemap") {
    document.metadata.scrapeId = meta.id;
    const hooks = scrapeHooks();
    if (hooks?.has("scrape.document.derived")) {
      const childLogger = meta.logger.child({
        method: "executeTransformers/scrape.document.derived",
      });
      document = await hooks.transform(
        "scrape.document.derived",
        document,
        toScrapeMeta(meta, childLogger),
      );
    }
    return coerceFieldsToFormats(meta, document);
  }

  if (hasFormatOfType(meta.options.formats, "rawBase64")) {
    return coerceFieldsToFormats(meta, document);
  }

  const executions: [string, number][] = [];

  for (const step of transformerStack) {
    if (typeof step !== "function") {
      const hooks = scrapeHooks();
      if (!hooks?.has(step.hook)) {
        continue;
      }
      const childLogger = meta.logger.child({
        method: "executeTransformers/" + step.hook,
      });
      const start = Date.now();
      document = await hooks.transform(
        step.hook,
        document,
        toScrapeMeta(meta, childLogger),
      );
      executions.push([step.hook, Date.now() - start]);
      continue;
    }
    const _meta = {
      ...meta,
      logger: meta.logger.child({
        method: "executeTransformers/" + step.name,
      }),
    };
    const start = Date.now();
    document = await step(_meta, document);
    executions.push([step.name, Date.now() - start]);
  }

  meta.logger.debug("Executed transformers.", { executions });

  return document;
}
