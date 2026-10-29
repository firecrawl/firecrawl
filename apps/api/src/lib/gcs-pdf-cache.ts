import { ApiError } from "@google-cloud/storage";
import type { FirePdfPageBlocks } from "../scraper/scrapeURL/engines/pdf/types";
import type { FirePdfProvenance } from "../scraper/scrapeURL/engines/pdf/fire-pdf/schema";
import { logger } from "./logger";
import { config } from "../config";
import crypto from "crypto";
import { storage } from "./gcs-jobs";

type PdfCacheProvider = "runpod" | "firepdf";

// Cache shape — markdown/html are required; pagesProcessed is optional so
// pre-existing entries (written before the field existed) round-trip cleanly
// and the caller can fall back to its own page-count signal on a stale hit.
export type CachedPdfResult = {
  markdown: string;
  html: string;
  pagesProcessed?: number;
  /** Physical page markdown; present only in page-capable cache variants. */
  pageMarkdown?: Array<{ page: number; markdown: string }>;
  /** Typed layout blocks (fire-pdf wire shape); present only in
   * block-capable cache variants. */
  blocks?: FirePdfPageBlocks[];
  /** fire-pdf's stamp for the result this entry holds. Absent on entries
   * written before it existed, which a cache policy reads as "unknown". */
  provenance?: FirePdfProvenance;
  /** When this entry was written (ISO-8601). */
  cachedAt?: string;
  /** The variant this entry was written under ("base" for the bare key). */
  variant?: string;
};

const PROVIDER_PREFIXES: Record<PdfCacheProvider, string> = {
  runpod: "pdf-cache-v2/",
  firepdf: "pdf-cache-firepdf/",
};

export function createPdfCacheKey(pdfContent: string | Buffer): string {
  return crypto.createHash("sha256").update(pdfContent).digest("hex");
}

/** Cache addressing: historically the key is sha256 of the inline base64
 * payload. Callers that never materialize the base64 (large PDFs submitted
 * by GCS reference) pass a precomputed key instead — namespaced by the
 * caller (e.g. `raw-<sha256-of-bytes>`) so the two keyspaces stay
 * distinct. */
export type PdfCacheKeyInput = string | { key: string };

/** The cache key for an input: sha256 of the inline base64 payload, or the
 * caller's precomputed `raw-<sha256>` key. Logged on every cache event so a
 * team report can be turned into the keys to purge. */
export function resolvePdfCacheKey(input: PdfCacheKeyInput): string {
  return typeof input === "string" ? createPdfCacheKey(input) : input.key;
}

/** Whether the content cache exists at all (self-hosted deployments may run
 * without a bucket). Callers check this before hashing a payload or spending
 * a refresh token for a cache that would neither read nor write. */
export function pdfCacheConfigured(): boolean {
  return !!config.GCS_BUCKET_NAME;
}

export async function savePdfResultToCache(
  pdfContent: PdfCacheKeyInput,
  result: CachedPdfResult,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<string | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = resolvePdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${objectKey}.json`);

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(JSON.stringify(result), {
          contentType: "application/json",
          metadata: {
            source: `${provider}_pdf_conversion`,
            cache_type: "pdf_markdown",
            created_at: new Date().toISOString(),
          },
        });

        logger.info(`Saved PDF result to GCS cache`, {
          cacheKey,
          provider,
        });

        return cacheKey;
      } catch (error) {
        if (i === 2) {
          throw error;
        } else {
          logger.error(`Error saving PDF result to GCS cache, retrying`, {
            error,
            cacheKey,
            provider,
            i,
          });
        }
      }
    }

    return cacheKey;
  } catch (error) {
    logger.error(`Error saving PDF result to GCS cache`, {
      error,
      provider,
    });
    return null;
  }
}

export async function getPdfResultFromCache(
  pdfContent: PdfCacheKeyInput,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<CachedPdfResult | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = resolvePdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${objectKey}.json`);

    const [content] = await blob.download();
    const result = JSON.parse(content.toString());

    logger.info(`Retrieved PDF result from GCS cache`, {
      cacheKey,
      provider,
    });

    return {
      ...result,
    };
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 404 &&
      error.message.includes("No such object:")
    ) {
      return null;
    }

    logger.error(`Error retrieving PDF result from GCS cache`, {
      error,
      provider,
    });
    return null;
  }
}
