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
function cacheKeyShape(
  mode: PDFMode | undefined,
  maxPages: number | undefined,
) {
  const cacheable = mode !== "fast" && !maxPages;
  const ownVariant: string | undefined = mode === "ocr" ? "ocr" : undefined;
  const lookupVariants: (string | undefined)[] =
    mode === "ocr" ? ["ocr"] : [undefined, "ocr"];
  return { cacheable, ownVariant, lookupVariants };
}

export async function tryGetCached(
  meta: Meta,
  base64Content: string,
  mode: PDFMode | undefined,
  maxPages: number | undefined,
  pagesProcessed: number | undefined,
): Promise<PDFProcessorResult | null> {
  if (meta.internalOptions.zeroDataRetention) return null;
  const { cacheable, lookupVariants } = cacheKeyShape(mode, maxPages);
  if (!cacheable) return null;

  for (const variant of lookupVariants) {
    try {
      const cached = await getPdfResultFromCache(
        base64Content,
        "firepdf",
        variant,
      );
      if (cached) {
        meta.logger.info("Using cached FirePDF result (async path)", {
          scrapeId: meta.id,
          requestedMode: mode,
          cacheVariant: variant ?? "base",
        });
        return {
          ...cached,
          pagesProcessed: cached.pagesProcessed ?? pagesProcessed,
        };
      }
    } catch (error) {
      meta.logger.warn(
        "Error checking FirePDF cache (async path), proceeding",
        { error, cacheVariant: variant ?? "base" },
      );
    }
  }
  return null;
}

export async function maybeSaveResult(args: {
  meta: Meta;
  base64Content: string;
  mode: PDFMode | undefined;
  maxPages: number | undefined;
  result: PDFProcessorResult & { markdown: string };
}): Promise<void> {
  const { meta, base64Content, mode, maxPages, result } = args;
  if (meta.internalOptions.zeroDataRetention) return;
  const { cacheable, ownVariant } = cacheKeyShape(mode, maxPages);
  if (!cacheable) return;

  try {
    await savePdfResultToCache(base64Content, result, "firepdf", ownVariant);
  } catch (error) {
    meta.logger.warn(
      "Error saving FirePDF async result to cache (continuing)",
      { error },
    );
  }
}
