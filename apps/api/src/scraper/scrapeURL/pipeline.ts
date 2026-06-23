import type { Document } from "../../controllers/v2/types";
import { getPDFMaxPages } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";
import { setSpanAttributes } from "../../lib/otel-tracer";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import { useIndex, useSearchIndex } from "../../services/index";
import { config } from "../../config";
import { ActionsNotSupportedError } from "../../lib/error";

import type { Meta, InternalOptions } from "./context";
import type { Engine, EngineScrapeResult, FeatureFlag } from "./types";
import { AbortManagerThrownError } from "./lib/abort-manager";
import {
  ActionError,
  BrandingNotSupportedError,
  DNSResolutionError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  ProxySelectionError,
  SiteError,
  SSLError,
  UnsupportedFileError,
} from "./error";

import {
  LLMRefusalError,
  performCleanContent,
  performLLMExtract,
  performSummary,
} from "./enrich/llm-extract";
import { performQuery } from "./enrich/query";
import { performAgent } from "./enrich/agent";
import { deriveDiff } from "./enrich/diff";
import { fetchAudio } from "./enrich/audio";
import { performAttributes } from "./derive/attributes";
import { removeBase64Images } from "./derive/remove-base64-images";
import { deriveHTMLFromRawHTML } from "./derive/html";
import { deriveMarkdownFromHTML } from "./derive/markdown";
import { deriveMetadataFromRawHTML } from "./derive/metadata";
import { deriveLinksFromHTML } from "./derive/links";
import { deriveImagesFromHTML } from "./derive/images";
import { deriveBrandingFromActions } from "./derive/branding";
import { uploadScreenshot } from "./emit/upload-screenshot";
import { sendDocumentToSearchIndex } from "./emit/search-index";
import { sendDocumentToIndex } from "./emit/cache-write";
import { forwardLinksToIndexer } from "./emit/link-indexer";

export type ScrapeUrlResponse =
  | {
      success: true;
      document: Document;
      unsupportedFeatures?: Set<FeatureFlag>;
    }
  | { success: false; error: any };

function childMeta(meta: Meta, method: string): Meta {
  return { ...meta, logger: meta.logger.child({ method }) };
}

export function buildDocument(
  meta: Meta,
  result: EngineScrapeResult,
  engine: Engine,
): Document {
  const servedFromIndex = engine === "index";
  return {
    markdown: result.markdown,
    rawHtml: result.html,
    screenshot: result.screenshot,
    actions: result.actions,
    branding: result.branding,
    metadata: {
      sourceURL: meta.sourceURL,
      url: result.url,
      statusCode: result.statusCode,
      error: result.error,
      numPages: result.pdfMetadata?.numPages,
      ...(result.pdfMetadata?.title ? { title: result.pdfMetadata.title } : {}),
      contentType: result.contentType,
      timezone: result.timezone,
      proxyUsed: result.proxyUsed,
      ...(servedFromIndex
        ? result.cacheInfo
          ? {
              cacheState: "hit" as const,
              cachedAt: result.cacheInfo.created_at.toISOString(),
            }
          : { cacheState: "miss" as const }
        : {}),
      postprocessorsUsed: result.postprocessorsUsed,
    },
  };
}

export async function runDerive(
  meta: Meta,
  document: Document,
): Promise<Document> {
  document = await deriveHTMLFromRawHTML(
    childMeta(meta, "deriveHTMLFromRawHTML"),
    document,
  );
  document = await deriveMarkdownFromHTML(
    childMeta(meta, "deriveMarkdownFromHTML"),
    document,
  );
  document = await deriveLinksFromHTML(
    childMeta(meta, "deriveLinksFromHTML"),
    document,
  );
  document = await deriveImagesFromHTML(
    childMeta(meta, "deriveImagesFromHTML"),
    document,
  );
  document = await deriveBrandingFromActions(
    childMeta(meta, "deriveBrandingFromActions"),
    document,
  );
  document = await deriveMetadataFromRawHTML(
    childMeta(meta, "deriveMetadataFromRawHTML"),
    document,
  );
  document = await performAttributes(
    childMeta(meta, "performAttributes"),
    document,
  );
  return document;
}

export async function runEnrich(
  meta: Meta,
  document: Document,
): Promise<Document> {
  document = await performCleanContent(
    childMeta(meta, "performCleanContent"),
    document,
  );
  document = await performLLMExtract(
    childMeta(meta, "performLLMExtract"),
    document,
  );
  document = await performSummary(childMeta(meta, "performSummary"), document);
  document = await performQuery(childMeta(meta, "performQuery"), document);
  document = await performAgent(childMeta(meta, "performAgent"), document);
  document = await removeBase64Images(
    childMeta(meta, "removeBase64Images"),
    document,
  );
  document = await deriveDiff(childMeta(meta, "deriveDiff"), document);
  document = await fetchAudio(childMeta(meta, "fetchAudio"), document);
  return document;
}

export async function runEmit(
  meta: Meta,
  document: Document,
  engine: Engine,
): Promise<void> {
  await uploadScreenshot(childMeta(meta, "uploadScreenshot"), document);
  if (useIndex) {
    await sendDocumentToIndex(
      childMeta(meta, "sendDocumentToIndex"),
      document,
      engine,
    );
  }
  if (useSearchIndex) {
    await sendDocumentToSearchIndex(
      childMeta(meta, "sendDocumentToSearchIndex"),
      document,
    );
  }
  await forwardLinksToIndexer(
    childMeta(meta, "forwardLinksToIndexer"),
    document,
  );
}

export function shouldUseIndex(meta: Meta): boolean {
  const shot = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    shot?.viewport !== undefined || shot?.quality !== undefined;

  return (
    useIndex &&
    config.FIRECRAWL_INDEX_WRITE_ONLY !== true &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    !hasFormatOfType(meta.options.formats, "branding") &&
    getPDFMaxPages(meta.options.parsers) === undefined &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.profile === undefined
  );
}

const ERROR_KINDS: Array<[new (...args: any[]) => Error, string, string]> = [
  [LLMRefusalError, "LLMRefusalError", "LLM refused to extract content"],
  [SiteError, "SiteError", "Site failed to load in browser"],
  [SSLError, "SSLError", "SSL error"],
  [ActionError, "ActionError", "Action(s) failed to complete"],
  [UnsupportedFileError, "UnsupportedFileError", "Unsupported file type"],
  [
    PDFInsufficientTimeError,
    "PDFInsufficientTimeError",
    "Insufficient time to process PDF",
  ],
  [
    PDFOCRRequiredError,
    "PDFOCRRequiredError",
    "PDF requires OCR but fast mode was requested",
  ],
  [
    BrandingNotSupportedError,
    "BrandingNotSupportedError",
    "Branding not supported for this content",
  ],
  [ProxySelectionError, "ProxySelectionError", "Proxy selection error"],
  [DNSResolutionError, "DNSResolutionError", "DNS resolution error"],
];

function classify(meta: Meta, error: any): string {
  if (
    error instanceof Error &&
    error.message.includes("Invalid schema for response_format")
  ) {
    meta.logger.warn("scrapeURL: LLM schema error", { error });
    return "LLMSchemaError";
  }
  for (const [cls, name, msg] of ERROR_KINDS) {
    if (error instanceof cls) {
      meta.logger.warn("scrapeURL: " + msg, { error });
      return name;
    }
  }
  if (error instanceof AbortManagerThrownError)
    return "AbortManagerThrownError";
  if (error instanceof ActionsNotSupportedError)
    return "ActionsNotSupportedError";
  return "unknown";
}

export function handleScrapeError(
  meta: Meta,
  error: any,
  startTime: number,
  span: any,
  internalOptions: InternalOptions,
): ScrapeUrlResponse {
  const errorType = classify(meta, error);
  if (errorType === "AbortManagerThrownError") {
    throw (error as AbortManagerThrownError).inner;
  }
  if (errorType === "unknown") {
    captureExceptionWithZdrCheck(error, {
      extra: { zeroDataRetention: internalOptions.zeroDataRetention ?? false },
    });
    meta.logger.error("scrapeURL: Unexpected error happened", { error });
  }
  setSpanAttributes(span, {
    "scrape.success": false,
    "scrape.error": error instanceof Error ? error.message : String(error),
    "scrape.error_type": errorType,
    "scrape.duration_ms": Date.now() - startTime,
  });
  return { success: false, error };
}

export function logScrapeMetrics(
  meta: Meta,
  startTime: number,
  success: boolean,
  indexHit: boolean,
): void {
  const base = {
    module: "scrapeURL/metrics",
    timeTaken: Date.now() - startTime,
    maxAgeValid: (meta.options.maxAge ?? 0) > 0,
    shouldUseIndex: shouldUseIndex(meta),
    success,
    indexHit,
  };
  if (!useIndex) {
    meta.logger.debug("scrapeURL metrics", base);
    return;
  }
  meta.logger.debug("scrapeURL metrics", {
    ...base,
    changeTrackingEnabled: !!hasFormatOfType(
      meta.options.formats,
      "changeTracking",
    ),
    summaryEnabled: !!hasFormatOfType(meta.options.formats, "summary"),
    jsonEnabled: !!hasFormatOfType(meta.options.formats, "json"),
    screenshotEnabled: !!hasFormatOfType(meta.options.formats, "screenshot"),
    imagesEnabled: !!hasFormatOfType(meta.options.formats, "images"),
    brandingEnabled: !!hasFormatOfType(meta.options.formats, "branding"),
    pdfMaxPages: getPDFMaxPages(meta.options.parsers),
    maxAge: meta.options.maxAge,
    headers: meta.options.headers
      ? Object.keys(meta.options.headers).length
      : 0,
    actions: meta.options.actions?.length ?? 0,
    proxy: meta.options.proxy,
  });
}
