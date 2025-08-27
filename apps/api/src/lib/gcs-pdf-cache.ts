import { Storage } from "@google-cloud/storage";
import { logger } from "./logger";
import crypto from "crypto";

const credentials = process.env.GCS_CREDENTIALS ? JSON.parse(atob(process.env.GCS_CREDENTIALS)) : undefined;
const PDF_CACHE_PREFIX = "pdf-cache-v2/";

/**
 * Creates a SHA-256 hash of the PDF content to use as a cache key
 * Directly hashes the content without any conversion
 */
export function createPdfCacheKey(pdfContent: string | Buffer): string {
    return crypto
        .createHash('sha256')
        .update(pdfContent)
        .digest('hex');
}

/**
 * Save RunPod markdown results to GCS cache
 */
export async function savePdfResultToCache(
    pdfContent: string,
    result: { markdown: string; html: string }
): Promise<string | null> {
    try {
        if (!process.env.GCS_BUCKET_NAME) {
            return null;
        }

        const cacheKey = createPdfCacheKey(pdfContent);
        const storage = new Storage({ credentials });
        const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
        const blob = bucket.file(`${PDF_CACHE_PREFIX}${cacheKey}.json`);

        for (let i = 0; i < 3; i++) {
            try {
                await blob.save(JSON.stringify(result), {
                    contentType: "application/json",
                    metadata: {
                        source: "runpod_pdf_conversion",
                        cache_type: "pdf_markdown",
                        created_at: new Date().toISOString(),
                    }
                });

                logger.info(`Saved PDF RunPod result to GCS cache`, {
                    cacheKey,
                });

                return cacheKey;
            } catch (error) {
                if (i === 2) {
                    throw error;
                } else {
                    logger.error(`Error saving PDF RunPod result to GCS cache, retrying`, {
                        error,
                        cacheKey,
                        i,
                    });
                }
            }
        }

        return cacheKey;
    } catch (error) {
        logger.error(`Error saving PDF RunPod result to GCS cache`, {
            error,
        });
        return null;
    }
}

/**
 * Get cached RunPod markdown results from GCS
 */
export async function getPdfResultFromCache(
    pdfContent: string
): Promise<{ markdown: string; html: string } | null> {
    try {
        if (!process.env.GCS_BUCKET_NAME) {
            return null;
        }

        const cacheKey = createPdfCacheKey(pdfContent);
        const storage = new Storage({ credentials });
        const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
        const blob = bucket.file(`${PDF_CACHE_PREFIX}${cacheKey}.json`);

        const [exists] = await blob.exists();
        if (!exists) {
            logger.debug(`PDF RunPod result not found in GCS cache`, {
                cacheKey,
            });
            return null;
        }

        const [content] = await blob.download();
        const result = JSON.parse(content.toString());

        logger.info(`Retrieved PDF RunPod result from GCS cache`, {
            cacheKey,
        });

        return {
            ...result,
        };
    } catch (error) {
        logger.error(`Error retrieving PDF RunPod result from GCS cache`, {
            error,
        });
        return null;
    }
}