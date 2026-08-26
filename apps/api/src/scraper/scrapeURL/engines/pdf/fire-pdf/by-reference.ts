import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import { storage } from "../../../../../lib/gcs-jobs";

/** Input handle for a FirePDF async submit that travels by GCS reference
 * instead of inline base64. Produced by {@link uploadPdfInputForFirePdf}. */
export type FirePdfByReferenceInput = {
  gcsUri: string;
  sha256: string;
  sizeBytes: number;
};

/** Uploading 256MB in-cluster to GCS is seconds; this bound exists so a
 * stuck stream cannot hold a scrape slot indefinitely. */
const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * Whether by-reference FirePDF routing is configured and permitted for this
 * request, judged from signals available before the file is downloaded.
 * Both the download-size admission and the routing gate use this ONE
 * predicate; the routing gate then adds the file-dependent conditions
 * (size window, page count, MinerU diversion).
 *
 * ZDR is excluded because the by-reference input object persists in GCS.
 * A forced FirePDF request (pages/blocks/markers) needs only the base URL,
 * mirroring the inline path's rule; otherwise both the master switch and
 * the by-reference switch must be on.
 */
export function byReferenceConfigured(
  meta: Meta,
  forceFirePdfRequested: boolean,
): boolean {
  return (
    !meta.internalOptions.zeroDataRetention &&
    !!config.FIRE_PDF_BASE_URL &&
    (forceFirePdfRequested ||
      (!!config.FIRE_PDF_ENABLE && config.FIRE_PDF_BY_REFERENCE_ENABLE))
  );
}

/**
 * Stream a downloaded PDF from its temp file into the fire-pdf input bucket
 * so the async pipeline can fetch it by reference. Single pass: the sha-256
 * (fire-pdf's idempotency identity) is computed through a transform inside
 * the upload pipeline, so the file is read exactly once and never buffered.
 * A timeout or scrape cancellation aborts the transfer itself (both streams
 * are destroyed) — the caller may unlink the temp file as soon as this
 * returns.
 *
 * Cleanup contract: the uploaded object is deliberately NOT deleted here or
 * on job completion. fire-pdf's committed-retry replay depends on the input
 * object outliving the job, and the bucket's prefix-scoped lifecycle policy
 * (inputs/ deleted after 1 day, owned with the bucket in infra) is the
 * cleanup mechanism.
 *
 * Returns null on any failure (missing bucket grant, timeout, transport):
 * the caller falls back to the pre-by-reference behavior for oversized
 * files instead of failing the scrape on infra misconfiguration.
 */
/** Streaming sha-256 of a file on disk. The by-reference cache identity —
 * computed BEFORE any upload so a cache hit skips the 30-256MB transfer
 * entirely. A disk read is orders of magnitude cheaper than the upload it
 * can save. */
export async function sha256OfFile(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function uploadPdfInputForFirePdf(
  meta: Meta,
  tempFilePath: string,
  sizeBytes: number,
  opts?: {
    /** sha-256 already computed over this exact file (e.g. for the
     * pre-upload cache check) — skips the in-pipeline hash pass. */
    precomputedSha256?: string;
  },
): Promise<FirePdfByReferenceInput | null> {
  const bucketName = config.FIRE_PDF_GCS_INPUT_BUCKET;
  // Scrape ids are UUIDv7 (time-ordered); a short hash prefix spreads the
  // keys across GCS partitions, same convention as gcs-jobs.ts.
  const keyPrefix = createHash("sha256")
    .update(meta.id)
    .digest("hex")
    .slice(0, 8);
  const objectKey = `inputs/${keyPrefix}-${meta.id}.pdf`;
  const startedAt = Date.now();
  try {
    // Both the hash pass and the upload stop on scrape cancellation as
    // well as the local timeout — a cancelled request must not keep
    // reading and uploading hundreds of MB it can no longer use.
    const timeoutAbort = new AbortController();
    const signal = AbortSignal.any([
      timeoutAbort.signal,
      meta.abort.asSignal(),
    ]);
    const timer = setTimeout(
      () =>
        timeoutAbort.abort(
          new Error(`GCS input upload timed out after ${UPLOAD_TIMEOUT_MS}ms`),
        ),
      UPLOAD_TIMEOUT_MS,
    );
    const hash =
      opts?.precomputedSha256 === undefined ? createHash("sha256") : null;
    try {
      // Stream construction lives inside the timer-owning try: a
      // synchronous createWriteStream throw must still clear the timeout.
      const writeStream = storage
        .bucket(bucketName)
        .file(objectKey)
        .createWriteStream({
          resumable: true,
          metadata: {
            contentType: "application/pdf",
            metadata: { scrape_id: meta.id, source: "firecrawl" },
          },
        });
      if (hash) {
        const hashThrough = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk as Buffer);
            callback(null, chunk);
          },
        });
        await pipeline(
          createReadStream(tempFilePath),
          hashThrough,
          writeStream,
          {
            signal,
          },
        );
      } else {
        await pipeline(createReadStream(tempFilePath), writeStream, { signal });
      }
    } finally {
      clearTimeout(timer);
    }
    const sha256 = opts?.precomputedSha256 ?? hash!.digest("hex");
    meta.logger.info("Uploaded large PDF for by-reference FirePDF submit", {
      method: "scrapePDF/firePdfByReference",
      event: "fire_pdf_by_reference_uploaded",
      scrape_id: meta.id,
      size_bytes: sizeBytes,
      duration_ms: Date.now() - startedAt,
      gcs_uri: `gs://${bucketName}/${objectKey}`,
    });
    return {
      gcsUri: `gs://${bucketName}/${objectKey}`,
      sha256,
      sizeBytes,
    };
  } catch (error) {
    // A cancelled scrape propagates as an abort, not a fallback — the
    // legacy chain must not keep processing a request nobody is waiting on.
    meta.abort.throwIfAborted();
    meta.logger.warn(
      "Large-PDF GCS input upload failed; falling back to legacy handling",
      {
        method: "scrapePDF/firePdfByReference",
        event: "fire_pdf_by_reference_upload_failed",
        scrape_id: meta.id,
        team_id: meta.internalOptions.teamId,
        size_bytes: sizeBytes,
        bucket: bucketName,
        error,
      },
    );
    return null;
  }
}
