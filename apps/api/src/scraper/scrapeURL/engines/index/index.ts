import crypto from "crypto";
import { config } from "../../../../config";
import { Document } from "../../../../controllers/v1/types";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import {
  getIndexFromGCS,
  hashURL,
  index_supabase_service,
  normalizeURLForIndex,
  saveIndexToGCS,
  generateURLSplits,
  addIndexInsertJob,
  generateDomainSplits,
  addOMCEJob,
} from "../../../../services";
import { EngineError, IndexMissError, NoCachedDataError } from "../../error";
import { shouldParsePDF } from "../../../../controllers/v2/types";
import { hasFormatOfType } from "../../../../lib/format-utils";

export async function sendDocumentToIndex(meta: Meta, document: Document) {
  if (meta.internalOptions.disableIndexing) {
    return document;
  }

  // Skip caching if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  const shouldCache =
    meta.options.storeInCache &&
    !meta.internalOptions.zeroDataRetention &&
    meta.winnerEngine !== "index" &&
    meta.winnerEngine !== "index;documents" &&
    !(meta.winnerEngine === "pdf" && !shouldParsePDF(meta.options.parsers)) &&
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
    (meta.internalOptions.teamId === "sitemap" ||
      (meta.winnerEngine !== "fire-engine;tlsclient" &&
        meta.winnerEngine !== "fire-engine;tlsclient;stealth" &&
        meta.winnerEngine !== "fetch")) &&
    !meta.featureFlags.has("actions") &&
    !hasCustomScreenshotSettings &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0);

  if (!shouldCache) {
    return document;
  }

  // Generate indexId synchronously and set it on document immediately
  // so it's available to other transformers (e.g., search index)
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
          url:
            document.metadata.url ??
            document.metadata.sourceURL ??
            meta.rewrittenUrl ??
            meta.url,
          html: document.rawHtml!,
          statusCode: document.metadata.statusCode,
          error: document.metadata.error,
          screenshot: document.screenshot,
          pdfMetadata:
            document.metadata.numPages !== undefined
              ? {
                  // reconstruct pdfMetadata from numPages and title
                  numPages: document.metadata.numPages,
                  title: document.metadata.title ?? undefined,
                }
              : undefined,
          contentType: document.metadata.contentType,
          postprocessorsUsed: document.metadata.postprocessorsUsed,
        });
      } catch (error) {
        meta.logger.error("Failed to save document to index", {
          error,
        });
        return document;
      }

      let title = document.metadata.title ?? document.metadata.ogTitle ?? null;
      let description =
        document.metadata.description ??
        document.metadata.ogDescription ??
        document.metadata.dcDescription ??
        null;

      if (typeof title === "string") {
        title = title.trim();
        if (title.length > 60) {
          title = title.slice(0, 57) + "...";
        }
      } else {
        title = null;
      }

      if (typeof description === "string") {
        description = description.trim();
        if (description.length > 160) {
          description = description.slice(0, 157) + "...";
        }
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
            document.metadata.url ??
            document.metadata.sourceURL ??
            meta.rewrittenUrl ??
            meta.url,
          has_screenshot:
            document.screenshot !== undefined &&
            meta.featureFlags.has("screenshot"),
          has_screenshot_fullscreen:
            document.screenshot !== undefined &&
            meta.featureFlags.has("screenshot@fullScreen"),
          is_mobile: meta.options.mobile,
          block_ads: meta.options.blockAds,
          location_country: meta.options.location?.country ?? null,
          location_languages: meta.options.location?.languages ?? null,
          status: document.metadata.statusCode,
          is_precrawl: meta.internalOptions.isPreCrawl === true,
          wait_time_ms: meta.options.waitFor > 0 ? meta.options.waitFor : null,
          ...urlSplitsHash.slice(0, 10).reduce(
            (a, x, i) => ({
              ...a,
              [`url_split_${i}_hash`]: x,
            }),
            {},
          ),
          ...domainSplitsHash.slice(0, 5).reduce(
            (a, x, i) => ({
              ...a,
              [`domain_splits_${i}_hash`]: x,
            }),
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
          meta.logger.warn("Failed to add domain to OMCE job queue", {
            error,
          });
        }
      }
    } catch (error) {
      meta.logger.error("Failed to save document to index (outer)", {
        error,
      });
    }
  })();

  return document;
}

const errorCountToRegister = 3;

export async function scrapeURLWithIndex(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const startTime = Date.now();
  const normalizedURL = normalizeURLForIndex(meta.url);
  const urlHash = hashURL(normalizedURL);

  let maxAge: number;
  if (meta.options.maxAge !== undefined) {
    maxAge = meta.options.maxAge;
  } else {
    const domainSplitsHash = generateDomainSplits(
      new URL(meta.url).hostname,
    ).map(x => hashURL(x));
    const level = domainSplitsHash.length - 1;

    if (
      domainSplitsHash.length === 0 ||
      config.FIRECRAWL_INDEX_WRITE_ONLY ||
      config.USE_DB_AUTHENTICATION !== true
    ) {
      maxAge = 2 * 24 * 60 * 60 * 1000; // 2 days
    } else {
      try {
        maxAge = await Promise.race([
          (async () => {
            const { data, error } = await index_supabase_service.rpc(
              "query_max_age",
              {
                i_domain_hash: domainSplitsHash[level],
              },
            );

            if (error || !data || data.length === 0) {
              meta.logger.warn("Failed to get max age from DB", {
                error,
              });
              return 2 * 24 * 60 * 60 * 1000; // 2 days
            }

            return data[0].max_age ?? 2 * 24 * 60 * 60 * 1000; // 2 days
          })(),
          new Promise(resolve =>
            setTimeout(() => {
              resolve(2 * 24 * 60 * 60 * 1000); // 2 days
            }, 200),
          ),
        ]);
      } catch (e) {
        meta.logger.warn("Failed to get max age from DB", {
          error: e,
        });
        maxAge = 2 * 24 * 60 * 60 * 1000; // 2 days
      }
    }
  }

  const checkpoint1 = Date.now();

  const { data, error } = await index_supabase_service.rpc(
    "index_get_recent_3",
    {
      p_url_hash: urlHash,
      p_max_age_ms: maxAge,
      p_is_mobile: meta.options.mobile,
      p_block_ads: meta.options.blockAds,
      p_feature_screenshot: meta.featureFlags.has("screenshot"),
      p_feature_screenshot_fullscreen: meta.featureFlags.has(
        "screenshot@fullScreen",
      ),
      p_location_country: meta.options.location?.country ?? null,
      p_location_languages:
        (meta.options.location?.languages?.length ?? 0) > 0
          ? meta.options.location?.languages
          : null,
      p_wait_time_ms: meta.options.waitFor,
      p_min_age_ms: meta.options.minAge ?? null,
    },
  );

  if (error || !data) {
    throw new EngineError("Failed to retrieve URL from DB index", {
      cause: error,
    });
  }

  let selectedRow: {
    id: string;
    created_at: string;
    status: number;
  } | null = null;

  if (data.length > 0) {
    const newest200Index = data.findIndex(
      x => x.status >= 200 && x.status < 300,
    );
    // If the newest 200 index is further back than the allowed error count, we should display the errored index entry
    if (newest200Index >= errorCountToRegister || newest200Index === -1) {
      selectedRow = data[0];
    } else {
      selectedRow = data[newest200Index];
    }
  }

  if (selectedRow === null || selectedRow === undefined) {
    meta.logger.debug("Index metrics", {
      module: "index/metrics",
      hit: false,
      maxAge,
      dynamicMaxAge: meta.options.maxAge === undefined,
      timingsFull: Date.now() - startTime,
      timingsMaxAge: checkpoint1 - startTime,
      timingsSupa: Date.now() - checkpoint1,
    });

    // when minAge is specified, don't waterfall to other engines
    if (meta.options.minAge !== undefined) {
      throw new NoCachedDataError();
    }

    throw new IndexMissError();
  }

  const checkpoint2 = Date.now();

  const id = data[0].id;

  const doc = await getIndexFromGCS(
    id + ".json",
    meta.logger.child({ module: "index", method: "getIndexFromGCS" }),
  );
  if (!doc) {
    meta.logger.warn("Index document not found in GCS", {
      indexDocumentId: id,
    });
    throw new EngineError("Document not found in GCS");
  }

  // Check if the cached content is a PDF base64 (starts with JVBERi)
  const isCachedPdfBase64 = doc.html && doc.html.startsWith("JVBERi");

  // If the cached content is base64 PDF but we want parsed PDF (parsePDF:true or default)
  if (isCachedPdfBase64 && shouldParsePDF(meta.options.parsers)) {
    // Cached content is unparsed PDF, but we want parsed - report cache miss
    throw new IndexMissError();
  }

  // If the cached content is NOT base64 PDF but we want unparsed PDF (parsePDF:false)
  if (!isCachedPdfBase64 && !shouldParsePDF(meta.options.parsers)) {
    // Check if URL looks like a PDF
    const isPdfUrl =
      meta.url.toLowerCase().endsWith(".pdf") || meta.url.includes(".pdf?");
    if (isPdfUrl) {
      // This is likely a parsed PDF cached, but we want unparsed - report cache miss
      throw new IndexMissError();
    }
  }

  meta.logger.debug("Index metrics", {
    module: "index/metrics",
    hit: true,
    age: Date.now() - new Date(selectedRow.created_at).getTime(),
    maxAge,
    dynamicMaxAge: meta.options.maxAge === undefined,
    timingsFull: Date.now() - startTime,
    timingsMaxAge: checkpoint1 - startTime,
    timingsSupa: checkpoint2 - checkpoint1,
    timingsGCS: Date.now() - checkpoint2,
  });

  return {
    url: doc.url,
    html: doc.html,
    statusCode: doc.statusCode,
    error: doc.error,
    screenshot: doc.screenshot,
    pdfMetadata:
      doc.pdfMetadata ??
      (doc.numPages !== undefined
        ? {
            // backwards-compatible shim of pdfMetadata without title
            numPages: doc.numPages,
          }
        : undefined),
    contentType: doc.contentType,

    cacheInfo: {
      created_at: new Date(data[0].created_at),
    },

    postprocessorsUsed: doc.postprocessorsUsed,

    proxyUsed: doc.proxyUsed ?? "basic",
  };
}

export function indexMaxReasonableTime(meta: Meta): number {
  return 1500;
}
