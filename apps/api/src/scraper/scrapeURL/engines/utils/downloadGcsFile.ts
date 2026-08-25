import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Logger } from "winston";
import { config } from "../../../../config";
import { storage } from "../../../../lib/gcs-jobs";
import { FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE } from "../pdf/types";

/** Downloading 256MB in-cluster from GCS is seconds; the bound exists so a
 * stuck stream cannot hold a scrape slot indefinitely. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

type FireEngineGcsFile = {
  uri: string;
  sha256?: string;
  sizeBytes?: number;
};

function parseGcsUri(
  uri: string,
): { bucket: string; objectKey: string } | null {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  return { bucket: match[1], objectKey: match[2] };
}

/**
 * Stream a fire-engine-uploaded file (large-PDF GCS handoff) from GCS to a
 * local temp path. The URI comes from a fire-engine response; only objects
 * inside fire-engine's configured handoff bucket are fetched — never an
 * arbitrary bucket named by response data.
 *
 * Returns the byte size written, or null on any failure (wrong bucket,
 * missing object, over-size, timeout) — callers treat null exactly like a
 * prefetch that came back empty.
 */
export async function downloadFireEngineGcsFile(
  logger: Logger,
  file: FireEngineGcsFile,
  destPath: string,
  signal?: AbortSignal,
): Promise<{ sizeBytes: number } | null> {
  const parsed = parseGcsUri(file.uri);
  if (!parsed || parsed.bucket !== config.FIRE_ENGINE_PDF_GCS_BUCKET) {
    logger.warn("fire-engine GCS file reference outside the handoff bucket", {
      uri: file.uri,
      expectedBucket: config.FIRE_ENGINE_PDF_GCS_BUCKET,
    });
    return null;
  }

  try {
    const object = storage.bucket(parsed.bucket).file(parsed.objectKey);
    const [metadata] = await object.getMetadata();
    const sizeBytes = Number(metadata.size ?? file.sizeBytes ?? 0);
    const generation = Number(metadata.generation);
    if (!(sizeBytes > 0) || sizeBytes > FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE) {
      logger.warn("fire-engine GCS file reference has unusable size", {
        uri: file.uri,
        sizeBytes,
        maxBytes: FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
      });
      return null;
    }

    const timeoutAbort = new AbortController();
    const combined = signal
      ? AbortSignal.any([timeoutAbort.signal, signal])
      : timeoutAbort.signal;
    const timer = setTimeout(
      () =>
        timeoutAbort.abort(
          new Error(
            `GCS file download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`,
          ),
        ),
      DOWNLOAD_TIMEOUT_MS,
    );
    try {
      // Pin the read to the generation whose size was just validated, so a
      // concurrent replacement of the object cannot bypass the size gate.
      const pinned = Number.isFinite(generation)
        ? storage.bucket(parsed.bucket).file(parsed.objectKey, { generation })
        : object;
      await pipeline(pinned.createReadStream(), createWriteStream(destPath), {
        signal: combined,
      });
    } finally {
      clearTimeout(timer);
    }
    return { sizeBytes };
  } catch (error) {
    logger.warn("fire-engine GCS file download failed", {
      uri: file.uri,
      error,
    });
    // A failed stream may have written a partial file that no prefetch
    // cleanup will ever see — remove it here.
    await unlink(destPath).catch(() => {});
    return null;
  }
}
