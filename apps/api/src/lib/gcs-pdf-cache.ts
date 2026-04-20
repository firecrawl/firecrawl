import { ApiError } from "@google-cloud/storage";
import { logger } from "./logger";
import { config } from "../config";
import crypto from "crypto";
import { storage } from "./gcs-jobs";

type PdfCacheProvider = "runpod" | "firepdf";

const PROVIDER_PREFIXES: Record<PdfCacheProvider, string> = {
  runpod: "pdf-cache-v2/",
  firepdf: "pdf-cache-firepdf/",
};

export function createPdfCacheKey(pdfContent: string | Buffer): string {
  return crypto.createHash("sha256").update(pdfContent).digest("hex");
}

export async function savePdfResultToCache(
  pdfContent: string,
  result: { markdown: string; html: string },
  provider: PdfCacheProvider = "runpod",
): Promise<string | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${cacheKey}.json`);

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
  pdfContent: string,
  provider: PdfCacheProvider = "runpod",
): Promise<{ markdown: string; html: string } | null> {
  try {
    if (!config.GCS_BUCKET_NAME) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const bucket = storage.bucket(config.GCS_BUCKET_NAME);
    const blob = bucket.file(`${prefix}${cacheKey}.json`);

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
