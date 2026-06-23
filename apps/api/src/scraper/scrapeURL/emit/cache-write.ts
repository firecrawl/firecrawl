import crypto from "crypto";
import { Document } from "../../../controllers/v1/types";
import type { Meta } from "../context";
import { hasFeature } from "../context";
import type { Engine } from "../types";
import {
  hashURL,
  normalizeURLForIndex,
  saveIndexToGCS,
  generateURLSplits,
  addIndexInsertJob,
  generateDomainSplits,
  addOMCEJob,
} from "../../../services";
import { shouldParsePDF } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function sendDocumentToIndex(
  meta: Meta,
  document: Document,
  engine: Engine,
): Promise<Document> {
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  const shouldCache =
    meta.options.storeInCache &&
    !meta.internalOptions.zeroDataRetention &&
    engine !== "index" &&
    !(engine === "pdf" && !shouldParsePDF(meta.options.parsers)) &&
    !meta.options.parsers?.some(parser => {
      if (
        typeof parser === "object" &&
        parser !== null &&
        "maxPages" in parser
      ) {
        return true;
      }
      return false;
    }) &&
    !hasFeature(meta, "actions") &&
    !hasCustomScreenshotSettings &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    meta.options.profile === undefined;

  if (!shouldCache) {
    return document;
  }

  // Generate indexId synchronously so other emitters (search-index) see it.
  const indexId = crypto.randomUUID();
  document.metadata.indexId = indexId;

  (async () => {
    try {
      const normalizedURL = normalizeURLForIndex(meta.url);
      const urlHash = hashURL(normalizedURL);

      const urlSplits = generateURLSplits(normalizedURL);
      const urlSplitsHash = urlSplits.map(split => hashURL(split));

      const urlObj = new URL(normalizedURL);
      const hostname = urlObj.hostname;

      const fakeDomain = meta.options.__experimental_omceDomain;
      const domainSplits = generateDomainSplits(hostname, fakeDomain);
      const domainSplitsHash = domainSplits.map(split => hashURL(split));

      try {
        await saveIndexToGCS(indexId, {
          url: document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
          html: document.rawHtml!,
          statusCode: document.metadata.statusCode,
          error: document.metadata.error,
          screenshot: document.screenshot,
          pdfMetadata:
            document.metadata.numPages !== undefined
              ? {
                  numPages: document.metadata.numPages,
                  title: document.metadata.title ?? undefined,
                }
              : undefined,
          contentType: document.metadata.contentType,
          postprocessorsUsed: document.metadata.postprocessorsUsed,
        });
      } catch (error) {
        meta.logger.error("Failed to save document to index", { error });
        return;
      }

      let title = document.metadata.title ?? document.metadata.ogTitle ?? null;
      let description =
        document.metadata.description ??
        document.metadata.ogDescription ??
        document.metadata.dcDescription ??
        null;

      if (typeof title === "string") {
        title = title.trim();
        if (title.length > 60) title = title.slice(0, 57) + "...";
      } else {
        title = null;
      }

      if (typeof description === "string") {
        description = description.trim();
        if (description.length > 160)
          description = description.slice(0, 157) + "...";
      } else {
        description = null;
      }

      try {
        await addIndexInsertJob({
          id: indexId,
          url: normalizedURL,
          url_hash: urlHash,
          original_url: document.metadata.sourceURL ?? meta.url,
          resolved_url:
            document.metadata.url ?? document.metadata.sourceURL ?? meta.url,
          has_screenshot:
            document.screenshot !== undefined && hasFeature(meta, "screenshot"),
          has_screenshot_fullscreen:
            document.screenshot !== undefined &&
            hasFeature(meta, "screenshot@fullScreen"),
          is_mobile: meta.options.mobile,
          block_ads: meta.options.blockAds,
          location_country: meta.options.location?.country ?? null,
          location_languages: meta.options.location?.languages ?? null,
          status: document.metadata.statusCode,
          is_precrawl: meta.internalOptions.isPreCrawl === true,
          is_stealth: hasFeature(meta, "stealthProxy"),
          wait_time_ms: meta.options.waitFor > 0 ? meta.options.waitFor : null,
          ...urlSplitsHash
            .slice(0, 10)
            .reduce((a, x, i) => ({ ...a, [`url_split_${i}_hash`]: x }), {}),
          ...domainSplitsHash
            .slice(0, 5)
            .reduce(
              (a, x, i) => ({ ...a, [`domain_splits_${i}_hash`]: x }),
              {},
            ),
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
        });
      } catch (error) {
        meta.logger.error("Failed to add document to index insert queue", {
          error,
        });
      }

      if (domainSplits.length > 0) {
        try {
          await addOMCEJob([
            domainSplits.length - 1,
            domainSplitsHash.slice(-1)[0],
          ]);
        } catch (error) {
          meta.logger.warn("Failed to add domain to OMCE job queue", { error });
        }
      }
    } catch (error) {
      meta.logger.error("Failed to save document to index (outer)", { error });
    }
  })();

  return document;
}
