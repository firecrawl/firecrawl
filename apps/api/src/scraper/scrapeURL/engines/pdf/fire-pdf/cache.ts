import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import type { PDFProcessorResult } from "../types";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
  type PdfCacheKeyInput,
} from "../../../../../lib/gcs-pdf-cache";
import { firePdfBlockPagesSchema } from "./schema";

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
  const { cacheable, lookupVariants } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
  );
  if (!cacheable) return null;

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
        meta.logger.info("Using cached FirePDF result", {
          scrapeId: meta.id,
          requestedMode: mode,
          cacheVariant: variant ?? "base",
        });
        // Strip payloads the request didn't ask for so a richer sidecar
        // serves a poorer request without leaking extra capabilities.
        const { pageMarkdown, blocks, ...compactCached } = cached;
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
      });
    }
  }
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

  try {
    await savePdfResultToCache(base64Content, result, "firepdf", ownVariant);
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
        await savePdfResultToCache(
          base64Content,
          baseResult,
          "firepdf",
          baseVariant,
        );
      }
    }
  } catch (error) {
    meta.logger.warn("Error saving FirePDF result to cache (continuing)", {
      error,
    });
  }
}
