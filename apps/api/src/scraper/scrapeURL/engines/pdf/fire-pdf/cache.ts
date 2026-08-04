import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import type { PDFProcessorResult } from "../types";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../../lib/gcs-pdf-cache";

// Cache layout mirrors the sync `scrapePDFWithFirePDF` so async/sync share
// entries. `fast` mode bypasses entirely (hard cost ceiling — must fail on
// scanned PDFs, not serve a cached OCR result), as does any call with
// `maxPages` (the cached entry may have been written with a different cap).
const PAGE_MARKDOWN_VARIANT = "page-markdown-v1";
const OCR_PAGE_MARKDOWN_VARIANT = "ocr-page-markdown-v1";

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

export function cacheKeyShape(
  mode: PDFMode | undefined,
  maxPages: number | undefined,
  includePageMarkdown: boolean,
) {
  const cacheable = mode !== "fast" && !maxPages;
  const baseVariant: string | undefined = mode === "ocr" ? "ocr" : undefined;
  const ownVariant: string | undefined = includePageMarkdown
    ? mode === "ocr"
      ? OCR_PAGE_MARKDOWN_VARIANT
      : PAGE_MARKDOWN_VARIANT
    : baseVariant;

  // Page-aware requests may only consume page-capable artifacts. Legacy
  // requests prefer their compact entry but can reuse an enriched sidecar.
  const lookupVariants: (string | undefined)[] = includePageMarkdown
    ? mode === "ocr"
      ? [OCR_PAGE_MARKDOWN_VARIANT]
      : [PAGE_MARKDOWN_VARIANT, OCR_PAGE_MARKDOWN_VARIANT]
    : mode === "ocr"
      ? ["ocr", OCR_PAGE_MARKDOWN_VARIANT]
      : [undefined, PAGE_MARKDOWN_VARIANT, "ocr", OCR_PAGE_MARKDOWN_VARIANT];
  return { cacheable, ownVariant, baseVariant, lookupVariants };
}

export async function tryGetCached(
  meta: Meta,
  base64Content: string,
  mode: PDFMode | undefined,
  maxPages: number | undefined,
  pagesProcessed: number | undefined,
  includePageMarkdown: boolean,
): Promise<PDFProcessorResult | null> {
  if (meta.internalOptions.zeroDataRetention) return null;
  const { cacheable, lookupVariants } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
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
          (includePageMarkdown && !isValidPageMarkdown(cached.pageMarkdown))
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
        if (!includePageMarkdown) {
          const { pageMarkdown: _pageMarkdown, ...compactCached } = cached;
          return {
            ...compactCached,
            pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
          };
        }
        return {
          ...cached,
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
  base64Content: string;
  mode: PDFMode | undefined;
  maxPages: number | undefined;
  includePageMarkdown: boolean;
  result: PDFProcessorResult & { markdown: string };
}): Promise<void> {
  const { meta, base64Content, mode, maxPages, includePageMarkdown, result } =
    args;
  if (meta.internalOptions.zeroDataRetention) return;
  const { cacheable, ownVariant, baseVariant } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
  );
  if (!cacheable) return;

  try {
    await savePdfResultToCache(base64Content, result, "firepdf", ownVariant);
    // A page-capable parse is also a valid legacy result. Populate the compact
    // base key when it is missing so a later legacy request never repeats the
    // conversion. A page-sidecar miss can coexist with a warm legacy key during
    // rollout, so avoid rewriting that object. Strip the page payload to keep
    // the hot-path cache object small.
    if (includePageMarkdown && ownVariant !== baseVariant) {
      const existingBase = await getPdfResultFromCache(
        base64Content,
        "firepdf",
        baseVariant,
      );
      if (!existingBase || !isValidCachedDocument(existingBase)) {
        const { pageMarkdown: _pageMarkdown, ...baseResult } = result;
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
