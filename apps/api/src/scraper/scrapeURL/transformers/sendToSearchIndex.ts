/**
 * Transformer: Send Document to Search Index
 *
 * Integrates with the existing scraper transformer stack.
 * Queues documents for real-time search indexing.
 *
 * Sampling: Controlled via SEARCH_INDEX_SAMPLE_RATE (0.0-1.0)
 * - 0.1 = 10% of documents indexed (recommended for initial rollout)
 * - 1.0 = 100% of documents indexed (full production)
 */

import { Document } from "../../../controllers/v1/types";
import { indexDocumentIfEnabled } from "../../../lib/search-index-client";
import { logger as _logger } from "../../../lib/logger";
import { Meta } from "..";

/**
 * Check if document should be indexed for search
 */
function shouldIndexForSearch(meta: Meta, document: Document): boolean {
  if (meta.internalOptions.zeroDataRetention) {
    return false;
  }

  const statusCode = document.metadata.statusCode;
  if (statusCode < 200 || statusCode >= 300) {
    return false;
  }

  // Check if markdown content exists and is substantial
  const markdown = document.markdown ?? "";
  if (markdown.length < 200) {
    return false;
  }

  // Don't index if has auth headers (private content)
  if (
    meta.options.headers &&
    (meta.options.headers["Authorization"] || meta.options.headers["Cookie"])
  ) {
    return false;
  }

  // Don't index PDFs without parsing
  const isPdf = document.metadata.contentType?.includes("pdf");
  if (isPdf && !document.markdown) {
    return false;
  }

  return true;
}

/**
 * Determine if this document should be sampled for indexing
 */
function shouldSampleDocument(): boolean {
  // Get sample rate from environment (default 10% for safe rollout)
  const sampleRateStr = process.env.SEARCH_INDEX_SAMPLE_RATE || "0.1";
  const sampleRate = parseFloat(sampleRateStr);

  // Validate sample rate
  if (isNaN(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    _logger.warn("Invalid SEARCH_INDEX_SAMPLE_RATE, using 0.1 (10%)", {
      value: sampleRateStr,
    });
    return Math.random() < 0.1;
  }

  // Sample based on rate
  return Math.random() < sampleRate;
}

/**
 * Transformer: Send document to search index
 */
export async function sendDocumentToSearchIndex(
  meta: Meta,
  document: Document,
): Promise<Document> {
  // Check if search indexing is enabled via the SEARCH_SERVICE_URL
  const searchIndexEnabled =
    process.env.ENABLE_SEARCH_INDEX === "true" &&
    process.env.SEARCH_SERVICE_URL;

  meta.logger.debug("Sending document to search index", {
    url: meta.url,
    searchIndexEnabled,
  });

  if (!searchIndexEnabled) {
    return document;
  }

  // Apply sampling (canary rollout)
  if (!shouldSampleDocument()) {
    meta.logger.debug("Document not sampled for search indexing", {
      url: meta.url,
      sampleRate: process.env.SEARCH_INDEX_SAMPLE_RATE || "0.1",
    });
    return document;
  }

  // Check if document should be indexed
  if (!shouldIndexForSearch(meta, document)) {
    meta.logger.debug("Document not suitable for search index", {
      url: meta.url,
      statusCode: document.metadata.statusCode,
      markdownLength: document.markdown?.length ?? 0,
    });
    return document;
  }

  // Get the indexId from document metadata (set by sendDocumentToIndex transformer)
  // Format as GCS path: {indexId}.json
  const gcsPath = document.metadata.indexId;

  // Remove indexId from metadata after extracting it (internal field, shouldn't be exposed to user)
  delete document.metadata.indexId;

  // Send to search service via HTTP (async, don't block scraper)
  (async () => {
    try {
      await indexDocumentIfEnabled(
        {
          url: meta.url,
          resolvedUrl:
            document.metadata.url ??
            document.metadata.sourceURL ??
            meta.rewrittenUrl ??
            meta.url,
          title:
            document.metadata.title ?? document.metadata.ogTitle ?? undefined,
          description:
            document.metadata.description ??
            document.metadata.ogDescription ??
            undefined,
          markdown: document.markdown ?? "",
          html: document.rawHtml ?? "",
          statusCode: document.metadata.statusCode,
          gcsPath: gcsPath,
          screenshotUrl: document.screenshot ?? undefined,
          language: document.metadata.language ?? "en",
          country: meta.options.location?.country ?? undefined,
          isMobile: meta.options.mobile ?? false,
        },
        meta.logger,
      );

      meta.logger.debug("Sent document to search service", {
        url: meta.url,
      });
    } catch (error) {
      meta.logger.error("Failed to send document to search service", {
        error: (error as Error).message,
        url: meta.url,
      });
    }
  })();

  return document;
}
