import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import {
  getPDFBlocks,
  getPDFMode,
  getPDFPageMarkdown,
  getPDFPageMarkers,
} from "../../../../../controllers/v2/types";
import { deterministicPercentage } from "./routing";
import { storage } from "../../../../../lib/gcs-jobs";
import { FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE } from "../types";

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

/** Server-side rewrites are metadata-speed regardless of object size. */
const REWRITE_TIMEOUT_MS = 30_000;

function firePdfInputObjectKey(scrapeId: string, variant?: string): string {
  // Scrape ids are UUIDv7 (time-ordered); a short hash prefix spreads the
  // keys across GCS partitions, same convention as gcs-jobs.ts. The variant
  // suffix keeps transports on distinct keys: a timed-out (but still
  // running) rewrite must never race a fallback upload on the same object.
  const keyPrefix = createHash("sha256")
    .update(scrapeId)
    .digest("hex")
    .slice(0, 8);
  return `inputs/${keyPrefix}-${scrapeId}${variant ? `-${variant}` : ""}.pdf`;
}

/**
 * Server-side copy a fire-engine-uploaded PDF (the large-file GCS handoff)
 * into the fire-pdf input bucket, so the bytes never transit this process
 * at all. Requires the handoff to carry a sha256 (fire-pdf's idempotency
 * identity) — without one the caller must fall back to
 * {@link uploadPdfInputForFirePdf}, which computes it while streaming.
 *
 * Returns null on any failure; callers fall back to the streaming upload
 * (the bytes are already on local disk for detection anyway).
 */
export async function rewritePdfInputForFirePdf(
  meta: Meta,
  source: {
    uri: string;
    sha256: string;
    sizeBytes: number;
    /** Generation validated (and read) by the prefetch download — the copy
     * is pinned to it so a replaced object can never smuggle different
     * bytes past the local size/sniff checks. Kept as the SDK's string
     * representation: generations are int64 and must not be rounded
     * through a JS number. */
    generation?: string;
  },
): Promise<FirePdfByReferenceInput | null> {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(source.uri);
  if (!match || match[1] !== config.FIRE_ENGINE_PDF_GCS_BUCKET) {
    // Only copy out of fire-engine's handoff bucket — never an arbitrary
    // bucket named by response data.
    return null;
  }
  const destBucket = config.FIRE_PDF_GCS_INPUT_BUCKET;
  const destKey = firePdfInputObjectKey(meta.id);
  const startedAt = Date.now();
  try {
    // Never start the server-side copy for an already-cancelled scrape —
    // it would only create an orphaned input object.
    meta.abort.throwIfAborted();
    const destFile = storage.bucket(destBucket).file(destKey);
    let timer: NodeJS.Timeout | undefined;
    // copy() accepts no AbortSignal, so this only stops the wait (timeout or
    // scrape cancellation); a late copy cannot clobber anything because the
    // fallback upload uses a distinct object key.
    const abortSignal = meta.abort.asSignal();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`GCS rewrite timed out after ${REWRITE_TIMEOUT_MS}ms`),
          ),
        REWRITE_TIMEOUT_MS,
      );
      if (abortSignal.aborted) {
        reject(abortSignal.reason ?? new Error("aborted"));
        return;
      }
      abortSignal.addEventListener(
        "abort",
        () => reject(abortSignal.reason ?? new Error("aborted")),
        { once: true },
      );
    });
    try {
      // The rewrite carries the source object's metadata (fire-engine sets
      // contentType application/pdf at upload), so no overrides needed.
      const sourceFile =
        source.generation !== undefined
          ? storage
              .bucket(match[1])
              .file(match[2], { generation: source.generation })
          : storage.bucket(match[1]).file(match[2]);
      await Promise.race([sourceFile.copy(destFile), timeout]);
    } finally {
      clearTimeout(timer);
    }
    meta.logger.info("Rewrote fire-engine PDF handoff into fire-pdf inputs", {
      method: "scrapePDF/firePdfByReference",
      event: "fire_pdf_by_reference_rewritten",
      scrape_id: meta.id,
      size_bytes: source.sizeBytes,
      duration_ms: Date.now() - startedAt,
      source_uri: source.uri,
      gcs_uri: `gs://${destBucket}/${destKey}`,
    });
    return {
      gcsUri: `gs://${destBucket}/${destKey}`,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
    };
  } catch (error) {
    meta.abort.throwIfAborted();
    meta.logger.warn(
      "GCS rewrite of fire-engine PDF handoff failed; falling back to streaming upload",
      {
        method: "scrapePDF/firePdfByReference",
        event: "fire_pdf_by_reference_rewrite_failed",
        scrape_id: meta.id,
        source_uri: source.uri,
        error,
      },
    );
    return null;
  }
}

/**
 * The per-team large-PDF byte limit: the privileged cap for allowlisted
 * team ids, the default cap for everyone else, both clamped to the 256MB
 * architectural ceiling. Every acquisition path enforces this one number —
 * the direct-download admission, the fire-engine handoff download, the
 * by-reference routing gate, and (as pdfMaxSize) fire-engine's own capture
 * ceiling, so no path can admit bytes another would reject.
 */
export function largePdfLimitBytes(meta: Meta): number {
  const teamId = meta.internalOptions.teamId;
  const privilegedIds = new Set(
    (config.PDF_BY_REFERENCE_PRIVILEGED_TEAM_IDS ?? "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean),
  );
  const raw =
    teamId && privilegedIds.has(teamId)
      ? config.PDF_BY_REFERENCE_MAX_BYTES_PRIVILEGED
      : config.PDF_BY_REFERENCE_MAX_BYTES_DEFAULT;
  // Config is schema-validated to positive integers; the clamp bounds both
  // ends anyway so an invalid value can never reject every PDF or send
  // fire-engine a nonsensical pdfMaxSize.
  return Math.min(Math.max(raw, 1), FIRE_PDF_BY_REFERENCE_MAX_FILE_SIZE);
}

/** Whether this request is diverted to MinerU. Deterministic on the scrape
 * id (same distribution as a random draw) precisely so every gate — the
 * fire-engine handoff grant, the download admission, and the PDF engine's
 * routing — sees the SAME verdict; a per-call random draw would let them
 * drift. Keyed apart from the async-cohort hash. */
export function mineruDiverted(meta: Meta): boolean {
  return (
    config.MINERU_PERCENT > 0 &&
    deterministicPercentage(`mineru:${meta.id}`) < config.MINERU_PERCENT
  );
}

/** The full request-level reachability check — byReferenceConfigured plus
 * the parser options that force FirePDF, fast-mode exclusion (its cost
 * ceiling skips the whole FirePDF chain), and the MinerU diversion. One
 * definition shared by the PDF engine's download admission/routing gate
 * AND the fire-engine handoff grant, so the gates can never drift. */
export function byReferenceReachableForRequest(meta: Meta): boolean {
  const forceRequested =
    !!meta.options.__forceFirePDF ||
    getPDFPageMarkdown(meta.options.parsers) ||
    getPDFBlocks(meta.options.parsers) ||
    getPDFPageMarkers(meta.options.parsers);
  return (
    getPDFMode(meta.options.parsers) !== "fast" &&
    !(!forceRequested && mineruDiverted(meta)) &&
    byReferenceConfigured(meta, forceRequested)
  );
}

/**
 * Whether by-reference FirePDF routing is configured and permitted for this
 * request, judged from signals available before the file is downloaded.
 *
 * ZDR is excluded because the by-reference input object persists in GCS.
 * A forced FirePDF request (pages/blocks/markers) needs only the base URL,
 * mirroring the inline path's rule; otherwise both the master switch and
 * the by-reference switch must be on.
 */
function byReferenceConfigured(
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
    /** Distinct object-key suffix — pass when another transport (e.g. a
     * timed-out rewrite) may still be writing this scrape's default key. */
    keyVariant?: string;
  },
): Promise<FirePdfByReferenceInput | null> {
  const bucketName = config.FIRE_PDF_GCS_INPUT_BUCKET;
  const objectKey = firePdfInputObjectKey(meta.id, opts?.keyVariant);
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
    // A first asSignal() call AFTER cancellation returns a signal whose
    // abort listeners were attached post-abort and never fire — check the
    // manager directly before starting the timer or any stream.
    meta.abort.throwIfAborted();
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
