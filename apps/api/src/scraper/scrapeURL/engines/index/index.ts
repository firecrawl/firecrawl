import crypto from "crypto";
import { config } from "../../../../config";
import { Document } from "../../../../controllers/v1/types";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import {
  getIndexFromGCS,
  hashURL,
  normalizeURLForIndex,
  saveIndexToGCS,
  generateURLSplits,
  addIndexInsertJob,
  generateDomainSplits,
  addOMCEJob,
} from "../../../../services";
import { queryMaxAge, indexGetRecent5 } from "../../../../db/rpc";
import {
  deleteCachedIndexEntry,
  deriveIndexVariantKey,
  filterIndexEntries,
  getCachedIndexEntries,
  getCachedMaxAge,
  getCachedNegative,
  isNegativeStillValid,
  setCachedMaxAge,
  setCachedNegative,
  upsertCachedIndexEntries,
  useIndexCache,
  useIndexNegativeCache,
  type IndexCacheEntry,
} from "../../../../services/index-cache";
import { indexLookupCounter } from "../../../../lib/index-cache-metrics";
import {
  AgentIndexOnlyError,
  EngineError,
  IndexMissError,
  NoCachedDataError,
} from "../../error";
import { shouldParsePDF } from "../../../../controllers/v2/types";
import { hasFormatOfType } from "../../../../lib/format-utils";

export async function sendDocumentToIndex(meta: Meta, document: Document) {
  // Skip caching if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  const shouldCache =
    meta.options.storeInCache &&
    !meta.internalOptions.isParse &&
    !meta.internalOptions.zeroDataRetention &&
    meta.winnerEngine !== "index" &&
    meta.winnerEngine !== "index;documents" &&
    // Exchange-delivered content is never stored on the Firecrawl side:
    // every access must go through the Exchange and its ledger.
    meta.winnerEngine !== "exchange" &&
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
      Object.keys(meta.options.headers).length === 0) &&
    meta.options.profile === undefined;

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
          json: document.json,
          statusCode: document.metadata.statusCode,
          error: document.metadata.error,
          screenshot: document.screenshot,
          pdfMetadata:
            document.metadata.numPages !== undefined
              ? {
                  // reconstruct pdfMetadata from numPages, totalPages and title
                  numPages: document.metadata.numPages,
                  totalPages: document.metadata.totalPages ?? undefined,
                  title: document.metadata.title ?? undefined,
                }
              : undefined,
          contentType: document.metadata.contentType,
          postprocessorsUsed: document.metadata.postprocessorsUsed,
          proxyUsed: document.metadata.proxyUsed,
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
          is_stealth: meta.featureFlags.has("stealthProxy"),
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

  const defaultMaxAge = 2 * 24 * 60 * 60 * 1000; // 2 days

  type MaxAgeSource = "explicit" | "dynamic_cached" | "dynamic_db" | "default";
  let maxAge: number;
  let maxAgeSource: MaxAgeSource = "default";
  if (meta.options.maxAge !== undefined) {
    maxAge = meta.options.maxAge;
    maxAgeSource = "explicit";
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
      maxAge = defaultMaxAge;
    } else {
      try {
        const resolved = await Promise.race([
          (async (): Promise<{
            value: number;
            source: MaxAgeSource;
          }> => {
            try {
              const domainHash = domainSplitsHash[level];
              if (useIndexCache) {
                const cached = await getCachedMaxAge(domainHash, meta.logger);
                if (cached !== null) {
                  return {
                    value: cached.maxAge ?? defaultMaxAge,
                    source: "dynamic_cached",
                  };
                }
              }
              const data = await queryMaxAge(domainHash);
              const value =
                !data || data.length === 0 ? null : (data[0].max_age ?? null);
              if (useIndexCache) {
                setCachedMaxAge(domainHash, value, meta.logger).catch(() => {});
              }
              return { value: value ?? defaultMaxAge, source: "dynamic_db" };
            } catch (error) {
              meta.logger.warn("Failed to get max age from DB", { error });
              return { value: defaultMaxAge, source: "default" };
            }
          })(),
          new Promise<{ value: number; source: MaxAgeSource }>(resolve =>
            setTimeout(() => {
              resolve({ value: defaultMaxAge, source: "default" });
            }, 200),
          ),
        ]);
        maxAge = resolved.value;
        maxAgeSource = resolved.source;
      } catch (e) {
        meta.logger.warn("Failed to get max age from DB", {
          error: e,
        });
        maxAge = defaultMaxAge;
      }
    }
  }

  const checkpoint1 = Date.now();

  const variantKey = deriveIndexVariantKey({
    urlHash,
    isMobile: meta.options.mobile,
    blockAds: meta.options.blockAds,
    isStealth: meta.featureFlags.has("stealthProxy"),
    locationCountry: meta.options.location?.country ?? null,
    locationLanguages:
      (meta.options.location?.languages?.length ?? 0) > 0
        ? (meta.options.location?.languages ?? null)
        : null,
  });

  let cacheStatus: "hit" | "filtered" | "miss" | "error" | "disabled" =
    "disabled";
  let servedFromCache = false;
  let negativeHit = false;
  let timingsCache = 0;
  let timingsDb = 0;

  // Canonical log for every index URL->id lookup. debug = normal op, warn =
  // recovered weird op (cache failure with DB fallback, GCS self-heal),
  // error = failed op.
  const logLookup = (
    level: "debug" | "warn" | "error",
    dbResult: "hit" | "miss" | "error",
    extra: Record<string, unknown> = {},
  ) => {
    const outcome = negativeHit
      ? "cache_neg_hit"
      : cacheStatus === "hit"
        ? "cache_hit"
        : cacheStatus === "disabled"
          ? `db_only_${dbResult}`
          : `cache_${cacheStatus}_db_${dbResult}`;
    indexLookupCounter.inc({ outcome });
    const effectiveLevel =
      level === "debug" && cacheStatus === "error" ? "warn" : level;
    meta.logger[effectiveLevel]("Index URL lookup", {
      module: "index",
      method: "scrapeURLWithIndex",
      canonicalLog: "index/url_lookup",
      outcome,
      urlHash: urlHash.toString("hex"),
      variantKey,
      teamId: meta.internalOptions.teamId,
      scrapeId: meta.id,
      maxAge,
      maxAgeSource,
      minAge: meta.options.minAge ?? null,
      timingsMaxAge: checkpoint1 - startTime,
      timingsCache,
      timingsDb,
      timingsFull: Date.now() - startTime,
      ...extra,
    });
  };

  let data: { id: string; created_at: string; status: number }[] = [];

  if (useIndexCache) {
    const cacheStart = Date.now();
    const read = await getCachedIndexEntries(variantKey, meta.logger);
    timingsCache = Date.now() - cacheStart;
    if (read.status === "hit") {
      const filtered = filterIndexEntries(read.entries, {
        maxAgeMs: maxAge,
        minAgeMs: meta.options.minAge ?? null,
        needsScreenshot: meta.featureFlags.has("screenshot"),
        needsScreenshotFullscreen: meta.featureFlags.has(
          "screenshot@fullScreen",
        ),
        waitTimeMs: meta.options.waitFor,
      });
      if (filtered.length > 0) {
        data = filtered;
        servedFromCache = true;
        cacheStatus = "hit";
      } else {
        // The capped per-key entry list may have dropped rows the DB still
        // has, so an empty filter result must fall through to the DB.
        cacheStatus = "filtered";
      }
    } else {
      cacheStatus = read.status;
    }
  }

  // Negative cache: on a clean positive miss (key absent), a still-valid
  // negative marker proves there's no index entry for this window, so we can
  // skip Postgres. Not consulted on "filtered"/"error" (entries exist, or the
  // cache is unhealthy and we must fall back to the DB), nor for minAge
  // requests (different no-data semantics — NoCachedDataError, no waterfall).
  if (
    !servedFromCache &&
    useIndexNegativeCache &&
    cacheStatus === "miss" &&
    meta.options.minAge === undefined
  ) {
    const negStart = Date.now();
    const neg = await getCachedNegative(variantKey, meta.logger);
    timingsCache += Date.now() - negStart;
    if (
      neg !== null &&
      isNegativeStillValid(neg.emptyFrom, maxAge, Date.now())
    ) {
      negativeHit = true;
    }
  }

  if (!servedFromCache && !negativeHit) {
    const dbStart = Date.now();
    try {
      const rows = await indexGetRecent5({
        url_hash: urlHash,
        max_age_ms: maxAge,
        is_mobile: meta.options.mobile,
        block_ads: meta.options.blockAds,
        feature_screenshot: meta.featureFlags.has("screenshot"),
        feature_screenshot_fullscreen: meta.featureFlags.has(
          "screenshot@fullScreen",
        ),
        location_country: meta.options.location?.country ?? null,
        location_languages:
          (meta.options.location?.languages?.length ?? 0) > 0
            ? (meta.options.location?.languages ?? null)
            : null,
        wait_time_ms: meta.options.waitFor,
        is_stealth: meta.featureFlags.has("stealthProxy"),
        min_age_ms: meta.options.minAge ?? null,
      });
      timingsDb = Date.now() - dbStart;
      if (useIndexCache && rows.length > 0) {
        const entries: IndexCacheEntry[] = rows.map(row => ({
          id: row.id,
          created_at: row.created_at,
          status: row.status,
          has_screenshot: row.has_screenshot,
          has_screenshot_fullscreen: row.has_screenshot_fullscreen,
          wait_time_ms: row.wait_time_ms,
        }));
        upsertCachedIndexEntries(variantKey, entries, meta.logger).catch(
          () => {},
        );
      } else if (
        useIndexNegativeCache &&
        rows.length === 0 &&
        meta.options.minAge === undefined
      ) {
        // Confirmed empty for [dbStart - maxAge, dbStart]; record the left edge.
        setCachedNegative(variantKey, dbStart - maxAge, meta.logger).catch(
          () => {},
        );
      }
      data = rows;
    } catch (error) {
      timingsDb = Date.now() - dbStart;
      logLookup("error", "error", { error });
      throw new EngineError("Failed to retrieve URL from DB index", {
        cause: error,
      });
    }
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
    logLookup("debug", "miss");

    if (meta.internalOptions.agentIndexOnly) {
      throw new AgentIndexOnlyError();
    }

    // when minAge is specified, don't waterfall to other engines
    if (meta.options.minAge !== undefined) {
      throw new NoCachedDataError();
    }

    throw new IndexMissError();
  }

  const checkpoint2 = Date.now();

  const id = selectedRow.id;

  const doc = await getIndexFromGCS(
    id + ".json",
    meta.logger.child({ module: "index", method: "getIndexFromGCS" }),
    { indexCreatedAt: selectedRow.created_at },
  );
  if (!doc) {
    if (servedFromCache) {
      // Self-heal: drop the poisoned cache entry so it can't keep serving an
      // id whose document is gone.
      deleteCachedIndexEntry(variantKey, id, meta.logger).catch(() => {});
    }
    logLookup("warn", "hit", { gcsMiss: true, indexDocumentId: id });
    throw new EngineError("Document not found in GCS");
  }

  // Check if the cached content is a PDF base64 (starts with JVBERi)
  const isCachedPdfBase64 = doc.html && doc.html.startsWith("JVBERi");

  // If the cached content is base64 PDF but we want parsed PDF (parsePDF:true or default)
  if (isCachedPdfBase64 && shouldParsePDF(meta.options.parsers)) {
    // Cached content is unparsed PDF, but we want parsed - report cache miss
    logLookup("debug", "hit", { pdfMismatch: "cached_unparsed_want_parsed" });
    throw new IndexMissError();
  }

  // If the cached content is NOT base64 PDF but we want unparsed PDF (parsePDF:false)
  if (!isCachedPdfBase64 && !shouldParsePDF(meta.options.parsers)) {
    // Check if URL looks like a PDF
    const isPdfUrl =
      meta.url.toLowerCase().endsWith(".pdf") || meta.url.includes(".pdf?");
    if (isPdfUrl) {
      // This is likely a parsed PDF cached, but we want unparsed - report cache miss
      logLookup("debug", "hit", { pdfMismatch: "cached_parsed_want_unparsed" });
      throw new IndexMissError();
    }
  }

  logLookup("debug", "hit", {
    age: Date.now() - new Date(selectedRow.created_at).getTime(),
    status: selectedRow.status,
    indexDocumentId: id,
    timingsGcs: Date.now() - checkpoint2,
  });

  return {
    url: doc.url,
    html: doc.html,
    json: doc.json,
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
      created_at: new Date(selectedRow.created_at),
    },

    postprocessorsUsed: doc.postprocessorsUsed,

    proxyUsed:
      doc.proxyUsed ??
      (meta.featureFlags.has("stealthProxy") ? "stealth" : "basic"), // this can be dropped after june 2026, it's here to backfill proxyUsed for older index entries that don't have it
  };
}

export function indexMaxReasonableTime(meta: Meta): number {
  return 1500;
}
