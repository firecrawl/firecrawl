import type { Meta } from "../../..";
import { config } from "../../../../../config";
import {
  getPDFRefresh,
  type PDFMode,
} from "../../../../../controllers/v2/types";
import type { PDFProcessorResult } from "../types";
import {
  type CachedPdfResult,
  getPdfResultFromCache,
  resolvePdfCacheKey,
  savePdfResultToCache,
  type PdfCacheKeyInput,
} from "../../../../../lib/gcs-pdf-cache";
import { sniffImageContentTypeFromBase64 } from "../../../../../lib/image-formats";
import {
  type CacheRefusedReason,
  firePdfCacheEventsTotal,
  firePdfCacheRefusedWritesTotal,
} from "./metrics";
import { consumeRefresh } from "./refresh-budget";
import { firePdfBlockPagesSchema, type FirePdfProvenance } from "./schema";

// Raster images ride the same cache as PDFs (the image engine posts their
// bytes to the same FirePDF endpoint), but an EMPTY result for an image is
// not worth remembering: it is cheap to recompute, and it usually records a
// no-text gate decision or a transient failure rather than a property of the
// bytes. Cached empties outlived a gate change once and kept legible images
// blank for every later scrape of the same file, so they are neither served
// nor written for images. PDFs keep their empty results — a blank scan is a
// real, expensive-to-redo answer there. By-reference payloads (`{ key }`)
// are always PDFs.
function isRasterImagePayload(input: PdfCacheKeyInput): boolean {
  return (
    typeof input === "string" && sniffImageContentTypeFromBase64(input) !== null
  );
}

function isEmptyMarkdown(markdown: string): boolean {
  return markdown.trim().length === 0;
}

// Cache layout mirrors the sync `scrapePDFWithFirePDF` so async/sync share
// entries. `fast` mode bypasses entirely (hard cost ceiling — must fail on
// scanned PDFs, not serve a cached OCR result), as does any call with
// `maxPages` (the cached entry may have been written with a different cap).
const PAGE_MARKDOWN_VARIANT = "page-markdown-v1";
const OCR_PAGE_MARKDOWN_VARIANT = "ocr-page-markdown-v1";
const BLOCKS_VARIANT = "blocks-v1";
const OCR_BLOCKS_VARIANT = "ocr-blocks-v1";
const PAGE_MARKDOWN_BLOCKS_VARIANT = "page-markdown-blocks-v1";
const OCR_PAGE_MARKDOWN_BLOCKS_VARIANT = "ocr-page-markdown-blocks-v1";

// `page_markers` rewrites the document markdown itself (inter-page
// `<!-- page N -->` separators), unlike pages/blocks which are extra
// payloads beside unchanged markdown. Marker and non-marker artifacts can
// therefore never serve each other. Follow the `mode: ocr` dedicated-variant
// precedent: map every variant name into a disjoint `…markers…` family.
// Within that family the ocr/pages/blocks capability lattice applies
// unchanged, because those artifacts differ only in sidecars again.
function withPageMarkers(variant: string | undefined): string {
  if (variant === undefined) return "markers-v1";
  if (variant === "ocr") return "ocr-markers-v1";
  return variant.replace(/-v1$/, "-markers-v1");
}

function isValidCachedDocument(
  value: unknown,
): value is Pick<PDFProcessorResult, "html"> & { markdown: string } {
  if (typeof value !== "object" || value === null) return false;
  const cached = value as {
    markdown?: unknown;
    html?: unknown;
    pagesProcessed?: unknown;
  };
  return (
    typeof cached.markdown === "string" &&
    typeof cached.html === "string" &&
    (cached.pagesProcessed === undefined ||
      (typeof cached.pagesProcessed === "number" &&
        Number.isInteger(cached.pagesProcessed) &&
        cached.pagesProcessed >= 0))
  );
}

function isValidPageMarkdown(
  value: unknown,
): value is NonNullable<PDFProcessorResult["pageMarkdown"]> {
  return (
    Array.isArray(value) &&
    value.every(
      page =>
        typeof page === "object" &&
        page !== null &&
        Number.isInteger((page as { page?: unknown }).page) &&
        Number((page as { page: number }).page) > 0 &&
        typeof (page as { markdown?: unknown }).markdown === "string",
    )
  );
}

// Cached block sidecars must satisfy the full wire contract before being
// served — a malformed or stale GCS artifact is skipped (and regenerated)
// rather than surfaced as invalid public block data.
function isValidBlocks(
  value: unknown,
): value is NonNullable<PDFProcessorResult["blocks"]> {
  return firePdfBlockPagesSchema.safeParse(value).success;
}

export function cacheKeyShape(
  mode: PDFMode | undefined,
  maxPages: number | undefined,
  includePageMarkdown: boolean,
  includeBlocks: boolean,
  pageMarkers = false,
) {
  const cacheable = mode !== "fast" && !maxPages;
  const isOcr = mode === "ocr";
  const baseVariant: string | undefined = isOcr ? "ocr" : undefined;
  const ownVariant: string | undefined =
    includePageMarkdown && includeBlocks
      ? isOcr
        ? OCR_PAGE_MARKDOWN_BLOCKS_VARIANT
        : PAGE_MARKDOWN_BLOCKS_VARIANT
      : includeBlocks
        ? isOcr
          ? OCR_BLOCKS_VARIANT
          : BLOCKS_VARIANT
        : includePageMarkdown
          ? isOcr
            ? OCR_PAGE_MARKDOWN_VARIANT
            : PAGE_MARKDOWN_VARIANT
          : baseVariant;

  // Capability rule: a request may only consume artifacts carrying every
  // capability it asked for (pages/blocks), but can reuse a richer sidecar.
  // Compact entries are preferred, and `auto` may fall back to ocr-written
  // artifacts. Plain requests keep the historical 4-variant probe list —
  // the hot path is not taxed with block-sidecar lookups.
  const lookupVariants: (string | undefined)[] = includeBlocks
    ? includePageMarkdown
      ? isOcr
        ? [OCR_PAGE_MARKDOWN_BLOCKS_VARIANT]
        : [PAGE_MARKDOWN_BLOCKS_VARIANT, OCR_PAGE_MARKDOWN_BLOCKS_VARIANT]
      : isOcr
        ? [OCR_BLOCKS_VARIANT, OCR_PAGE_MARKDOWN_BLOCKS_VARIANT]
        : [
            BLOCKS_VARIANT,
            PAGE_MARKDOWN_BLOCKS_VARIANT,
            OCR_BLOCKS_VARIANT,
            OCR_PAGE_MARKDOWN_BLOCKS_VARIANT,
          ]
    : includePageMarkdown
      ? isOcr
        ? [OCR_PAGE_MARKDOWN_VARIANT, OCR_PAGE_MARKDOWN_BLOCKS_VARIANT]
        : [
            PAGE_MARKDOWN_VARIANT,
            PAGE_MARKDOWN_BLOCKS_VARIANT,
            OCR_PAGE_MARKDOWN_VARIANT,
            OCR_PAGE_MARKDOWN_BLOCKS_VARIANT,
          ]
      : isOcr
        ? ["ocr", OCR_PAGE_MARKDOWN_VARIANT]
        : [undefined, PAGE_MARKDOWN_VARIANT, "ocr", OCR_PAGE_MARKDOWN_VARIANT];
  if (pageMarkers) {
    return {
      cacheable,
      ownVariant: withPageMarkers(ownVariant),
      baseVariant: withPageMarkers(baseVariant),
      lookupVariants: lookupVariants.map(withPageMarkers),
    };
  }
  return { cacheable, ownVariant, baseVariant, lookupVariants };
}

export async function tryGetCached(
  meta: Meta,
  base64Content: PdfCacheKeyInput,
  mode: PDFMode | undefined,
  maxPages: number | undefined,
  pagesProcessed: number | undefined,
  includePageMarkdown: boolean,
  includeBlocks: boolean,
  pageMarkers = false,
): Promise<PDFProcessorResult | null> {
  if (meta.internalOptions.zeroDataRetention) return null;
  const { cacheable, lookupVariants, ownVariant } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
  );
  if (!cacheable) return null;
  const cacheKey = resolvePdfCacheKey(base64Content);

  // `parsers: [{ type: "pdf", refresh: true }]`: the caller wants this
  // document parsed again with the current pipeline. Within the team's
  // budget the read is skipped; the fresh result is still written, so the
  // entry is corrected for everyone. Over budget (or with the limiter
  // unavailable) the request is served normally and the decision logged.
  if (getPDFRefresh(meta.options?.parsers)) {
    const decision = await consumeRefresh(meta.internalOptions.teamId);
    if (decision === "allowed") {
      firePdfCacheEventsTotal.inc({
        event: "bypass_refresh",
        variant: ownVariant ?? "base",
      });
      meta.logger.info("FirePDF cache bypassed by refresh", {
        scrapeId: meta.id,
        requestedMode: mode,
        cacheKey,
      });
      return null;
    }
    firePdfCacheEventsTotal.inc({
      event: "bypass_refresh_denied",
      variant: ownVariant ?? "base",
    });
    meta.logger.warn("FirePDF cache refresh not applied", {
      scrapeId: meta.id,
      requestedMode: mode,
      cacheKey,
      decision,
      perMinute: config.FIRE_PDF_CACHE_REFRESH_PER_MINUTE,
    });
  }

  for (const variant of lookupVariants) {
    try {
      const cached = await getPdfResultFromCache(
        base64Content,
        "firepdf",
        variant,
      );
      if (cached) {
        if (
          !isValidCachedDocument(cached) ||
          (includePageMarkdown && !isValidPageMarkdown(cached.pageMarkdown)) ||
          (includeBlocks && !isValidBlocks(cached.blocks))
        ) {
          // Defense in depth: variant names are the capability boundary, but
          // never let a malformed/old artifact satisfy a cache lookup.
          continue;
        }
        if (
          isEmptyMarkdown(cached.markdown) &&
          isRasterImagePayload(base64Content)
        ) {
          // See isRasterImagePayload: an empty image result is a stale
          // verdict, not an answer. Re-run OCR and let the fresh result
          // decide (an empty one is not written back either).
          meta.logger.info(
            "Ignoring cached empty FirePDF result for a raster image",
            {
              scrapeId: meta.id,
              requestedMode: mode,
              cacheVariant: variant ?? "base",
            },
          );
          continue;
        }
        firePdfCacheEventsTotal.inc({
          event: "hit",
          variant: variant ?? "base",
        });
        meta.logger.info("Using cached FirePDF result", {
          scrapeId: meta.id,
          requestedMode: mode,
          cacheVariant: variant ?? "base",
          cacheKey,
          // Provenance of the entry, for cache-policy work and team reports.
          // Entries written before the stamp existed read as "unknown".
          generation: cached.provenance?.generation ?? "unknown",
          buildSha: cached.provenance?.build_sha ?? "unknown",
          cachedAt: cached.cachedAt ?? null,
        });
        // Strip payloads the request didn't ask for so a richer sidecar
        // serves a poorer request without leaking extra capabilities, and
        // the entry-only fields (provenance, cachedAt, variant) that are
        // cache bookkeeping rather than document content.
        const {
          pageMarkdown,
          blocks,
          provenance: _provenance,
          cachedAt: _cachedAt,
          variant: _variant,
          ...compactCached
        } = cached;
        return {
          ...compactCached,
          ...(includePageMarkdown ? { pageMarkdown } : {}),
          ...(includeBlocks ? { blocks } : {}),
          pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
        };
      }
    } catch (error) {
      meta.logger.warn("Error checking FirePDF cache, proceeding", {
        error,
        cacheVariant: variant ?? "base",
        cacheKey,
      });
    }
  }
  firePdfCacheEventsTotal.inc({ event: "miss", variant: ownVariant ?? "base" });
  return null;
}

/**
 * Why a result must not be remembered. Failed pages and pages that lost
 * layout (fire-pdf's `degraded_pages`) are usually transient — a fleet
 * incident, a deadline — and a cached copy would serve that outcome to
 * every later request for the document. Partial pages are content-caused
 * and expensive to redo, so those results are still cached; the stamp's
 * quality counts let a later policy refresh them first.
 */
export function cacheRefusalReason(
  failedPages: readonly number[] | null | undefined,
  provenance: FirePdfProvenance | undefined,
): CacheRefusedReason | null {
  if (failedPages && failedPages.length > 0) return "failed_pages";
  if ((provenance?.quality?.degraded_pages ?? 0) > 0) return "degraded_pages";
  return null;
}

export async function maybeSaveResult(args: {
  meta: Meta;
  base64Content: PdfCacheKeyInput;
  mode: PDFMode | undefined;
  maxPages: number | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers?: boolean;
  result: PDFProcessorResult & { markdown: string };
  /** fire-pdf's stamp for this result; stored verbatim with the entry. */
  provenance?: FirePdfProvenance;
  /** fire-pdf's `failed_pages` for this result; a non-empty list is not cached. */
  failedPages?: readonly number[] | null;
}): Promise<void> {
  const {
    meta,
    base64Content,
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers = false,
    result,
    provenance,
    failedPages,
  } = args;
  if (meta.internalOptions.zeroDataRetention) return;
  const { cacheable, ownVariant, baseVariant } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
  );
  if (!cacheable) return;
  // See isRasterImagePayload: never remember an empty result for an image.
  if (isEmptyMarkdown(result.markdown) && isRasterImagePayload(base64Content))
    return;
  const cacheKey = resolvePdfCacheKey(base64Content);

  const refusal = cacheRefusalReason(failedPages, provenance);
  if (refusal !== null) {
    firePdfCacheRefusedWritesTotal.inc({ reason: refusal });
    firePdfCacheEventsTotal.inc({
      event: "refused_write",
      variant: ownVariant ?? "base",
    });
    meta.logger.info("FirePDF result not cached", {
      scrapeId: meta.id,
      requestedMode: mode,
      cacheVariant: ownVariant ?? "base",
      cacheKey,
      reason: refusal,
      failedPages: failedPages?.length ?? 0,
      degradedPages: provenance?.quality?.degraded_pages ?? 0,
    });
    return;
  }

  const cachedAt = new Date().toISOString();
  const entry: CachedPdfResult = {
    ...result,
    ...(provenance ? { provenance } : {}),
    cachedAt,
    variant: ownVariant ?? "base",
  };

  try {
    // savePdfResultToCache returns null (without throwing) when GCS is not
    // configured or its retries are exhausted; only a persisted write is a
    // write.
    const savedKey = await savePdfResultToCache(
      base64Content,
      entry,
      "firepdf",
      ownVariant,
    );
    if (savedKey === null) {
      firePdfCacheEventsTotal.inc({
        event: "write_failed",
        variant: ownVariant ?? "base",
      });
      meta.logger.warn("FirePDF result not persisted to cache", {
        scrapeId: meta.id,
        requestedMode: mode,
        cacheVariant: ownVariant ?? "base",
        cacheKey,
      });
      return;
    }
    firePdfCacheEventsTotal.inc({
      event: "write",
      variant: ownVariant ?? "base",
    });
    meta.logger.info("Saved FirePDF result to cache", {
      scrapeId: meta.id,
      requestedMode: mode,
      cacheVariant: ownVariant ?? "base",
      cacheKey,
      generation: provenance?.generation ?? "unknown",
      buildSha: provenance?.build_sha ?? "unknown",
    });
    // An enriched (page/block-capable) parse is also a valid legacy result.
    // Populate the compact base key when it is missing so a later legacy
    // request never repeats the conversion. A sidecar miss can coexist with
    // a warm legacy key during rollout, so avoid rewriting that object.
    // Strip the enriched payloads to keep the hot-path cache object small.
    if ((includePageMarkdown || includeBlocks) && ownVariant !== baseVariant) {
      const existingBase = await getPdfResultFromCache(
        base64Content,
        "firepdf",
        baseVariant,
      );
      if (!existingBase || !isValidCachedDocument(existingBase)) {
        const {
          pageMarkdown: _pageMarkdown,
          blocks: _blocks,
          ...baseResult
        } = result;
        const baseEntry: CachedPdfResult = {
          ...baseResult,
          ...(provenance ? { provenance } : {}),
          cachedAt,
          variant: baseVariant ?? "base",
        };
        const savedBase = await savePdfResultToCache(
          base64Content,
          baseEntry,
          "firepdf",
          baseVariant,
        );
        firePdfCacheEventsTotal.inc({
          event: savedBase === null ? "write_failed" : "write",
          variant: baseVariant ?? "base",
        });
      }
    }
  } catch (error) {
    meta.logger.warn("Error saving FirePDF result to cache (continuing)", {
      error,
    });
  }
}
