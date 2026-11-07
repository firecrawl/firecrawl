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

/** Reject when `signal` fires while `promise` is pending — for GCS RPCs
 * that accept no AbortSignal of their own. The RPC itself may briefly
 * outlive the rejection; we stop waiting and never use its result. */
async function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  let onAbort: (() => void) | undefined;
  const abortP = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortP]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

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
  /** Admission cap for this request — pass the historical download cap when
   * the FirePDF by-reference route is unreachable, so an unusable large
   * handoff never consumes network and temp disk. Clamped to the
   * by-reference ceiling. */
  maxBytes?: number,
): Promise<{ sizeBytes: number; generation?: string } | null> {
  // An already-cancelled scrape must not proceed through any branch of
  // this function — not even the cheap allowlist rejections, whose null
  // returns would let the caller keep working on a dead request.
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  const parsed = parseGcsUri(file.uri);
  if (!parsed || parsed.bucket !== config.FIRE_ENGINE_PDF_GCS_BUCKET) {
    logger.warn("fire-engine GCS file reference outside the handoff bucket", {
      uri: file.uri,
      expectedBucket: config.FIRE_ENGINE_PDF_GCS_BUCKET,
    });
    return null;
  }
  const effectiveMaxBytes = Math.min(
    maxBytes ?? FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
    FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE,
  );

  const timeoutAbort = new AbortController();
  const combined = signal
    ? AbortSignal.any([timeoutAbort.signal, signal])
    : timeoutAbort.signal;
  const timer = setTimeout(
    () =>
      timeoutAbort.abort(
        new Error(`GCS file download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`),
      ),
    DOWNLOAD_TIMEOUT_MS,
  );
  try {
    const object = storage.bucket(parsed.bucket).file(parsed.objectKey);
    const [metadata] = await raceWithSignal(object.getMetadata(), combined);
    const sizeBytes = Number(metadata.size ?? file.sizeBytes ?? 0);
    // Generations are int64 — keep the SDK's string form, never a JS number.
    const generation =
      metadata.generation !== undefined && metadata.generation !== null
        ? String(metadata.generation)
        : undefined;
    if (!(sizeBytes > 0) || sizeBytes > effectiveMaxBytes) {
      logger.warn("fire-engine GCS file reference has unusable size", {
        uri: file.uri,
        sizeBytes,
        maxBytes: effectiveMaxBytes,
      });
      return null;
    }

    {
      // Pin the read to the generation whose size was just validated, so a
      // concurrent replacement of the object cannot bypass the size gate.
      const pinned =
        generation !== undefined
          ? storage.bucket(parsed.bucket).file(parsed.objectKey, { generation })
          : object;
      await pipeline(pinned.createReadStream(), createWriteStream(destPath), {
        signal: combined,
      });
    }
    return { sizeBytes, generation };
  } catch (error) {
    // A failed stream may have written a partial file that no prefetch
    // cleanup will ever see — remove it here.
    await unlink(destPath).catch(() => {});
    if (signal?.aborted) {
      // Caller cancellation propagates as a cancellation, never as a
      // synthetic prefetch failure.
      throw signal.reason ?? error;
    }
    logger.warn("fire-engine GCS file download failed", {
      uri: file.uri,
      error,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
