import { ApiError } from "@google-cloud/storage";
import type { FirePdfPageBlocks } from "../scraper/scrapeURL/engines/pdf/types";
import { logger } from "./logger";
import { config } from "../config";
import crypto from "crypto";
import { storage } from "./gcs-jobs";

type PdfCacheProvider = "runpod" | "firepdf";

// Cache shape — markdown/html are required; pagesProcessed is optional so
// pre-existing entries (written before the field existed) round-trip cleanly
// and the caller can fall back to its own page-count signal on a stale hit.
type CachedPdfResult = {
  markdown: string;
  html: string;
  pagesProcessed?: number;
  /** Physical page markdown; present only in page-capable cache variants. */
  pageMarkdown?: Array<{ page: number; markdown: string }>;
  /** Typed layout blocks (fire-pdf wire shape); present only in
   * block-capable cache variants. */
  blocks?: FirePdfPageBlocks[];
  /** ISO timestamp of when this entry was parsed. Stamped into the body on
   * save; reads on pre-existing entries fall back to the GCS object's
   * timeCreated. Undefined only when that fallback also failed — callers
   * enforcing a freshness window must treat that as expired. */
  createdAt?: string;
  /** fire-pdf parser quality version that produced this entry (firepdf tier
   * only). Absent on entries written before fire-pdf surfaced it — readers
   * treat absence as "old parser". */
  parserVersion?: number;
};

const PROVIDER_PREFIXES: Record<PdfCacheProvider, string> = {
  runpod: "pdf-cache-v2/",
  firepdf: "pdf-cache-firepdf/",
};

export function createPdfCacheKey(pdfContent: string | Buffer): string {
  return crypto.createHash("sha256").update(pdfContent).digest("hex");
}

export async function savePdfResultToCache(
  pdfContent: string,
  result: CachedPdfResult,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<string | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${objectKey}.json`);

    // Only the firepdf tier enforces freshness windows; keep RunPod payloads
    // unchanged so its callers (which return the cached object directly) never
    // see cache bookkeeping fields.
    const body = JSON.stringify(
      provider === "firepdf"
        ? ({
            ...result,
            createdAt: new Date().toISOString(),
          } satisfies CachedPdfResult)
        : result,
    );

    for (let i = 0; i < 3; i++) {
      try {
        await blob.save(body, {
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
  pdfContent: string,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<CachedPdfResult | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${objectKey}.json`);

    const [content] = await blob.download();
    const result = JSON.parse(content.toString());

    // Entries written before createdAt was stamped into the body: recover the
    // parse time from the object itself so freshness windows apply to the
    // whole corpus, not just new writes. On failure createdAt stays undefined
    // and window-enforcing callers treat the entry as expired (fail-fresh).
    // Only the firepdf tier enforces freshness — don't tax the legacy RunPod
    // path with an extra metadata request it never uses. The extra HEAD on
    // unstamped firepdf hits is transient by construction: every legacy entry
    // either expires within the freshness window (and its re-parse writes a
    // stamped body) or ages out entirely, and the sequential cost is dwarfed
    // by the parse it avoids.
    if (provider === "firepdf" && typeof result.createdAt !== "string") {
      try {
        const [objectMetadata] = await blob.getMetadata();
        if (typeof objectMetadata.timeCreated === "string") {
          result.createdAt = objectMetadata.timeCreated;
        }
      } catch (error) {
        logger.warn(`Failed to read PDF cache entry metadata for age`, {
          error,
          cacheKey,
          provider,
        });
      }
    }

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
