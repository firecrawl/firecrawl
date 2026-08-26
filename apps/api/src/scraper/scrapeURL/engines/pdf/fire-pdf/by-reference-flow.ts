import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import type { PDFProcessorResult } from "../types";
import { scrapePDFWithFirePDFAsync } from "./async";
import {
  rewritePdfInputForFirePdf,
  sha256OfFile,
  uploadPdfInputForFirePdf,
} from "./by-reference";
import { cacheKeyShape, tryGetCached } from "./cache";
import { lookupAdoptableFirePdfJob } from "./lookup";
import { buildFirePdfJobOptions, FirePdfAsyncFailure } from "./utils";

type FirePdfByReferenceAttemptArgs = {
  meta: Meta;
  tempFilePath: string;
  fileSizeBytes: number;
  /** Detected page count; the caller guarantees it is positive (fire-pdf
   * rejects by-reference submits without one). */
  pagesEstimate: number;
  mode: PDFMode | undefined;
  maxPages: number | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers: boolean;
};

/**
 * The full by-reference attempt for one large PDF, in cost order — each
 * step only runs when the previous one didn't already produce a result:
 *
 *   1. raw-sha cache lookup  (one streamed disk read)
 *   2. content adoption      (poll a live/done job for the same
 *                             bytes+options — no upload, no reprocessing)
 *   3. handoff rewrite or streaming upload, then a fresh async submit
 *
 * Returns the processor result, or null when the input could not even be
 * placed in the fire-pdf bucket (rewrite AND upload failed) — the caller
 * falls through to the legacy chain, preserving pre-by-reference
 * behavior. Anything after a successful placement throws on failure
 * instead: there is no inline retry at this size, and the legacy chain
 * would silently degrade a large document to text-only extraction.
 *
 * Kept out of the engine router on purpose: this is transport/lifecycle
 * recovery, not routing.
 */
export async function runFirePdfByReferenceAttempt(
  args: FirePdfByReferenceAttemptArgs,
): Promise<PDFProcessorResult | null> {
  const {
    meta,
    tempFilePath,
    fileSizeBytes,
    pagesEstimate,
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
  } = args;

  // Cache BEFORE upload: the raw-byte sha is the by-reference cache
  // identity, and it must be checked before the 30-256MB transfer —
  // a repeat scrape of the same document should cost one streamed
  // disk read, not a full re-upload. scrapePDFWithFirePDFAsync
  // deliberately skips the by-reference lookup for the same reason
  // (it runs post-upload) and only saves.
  //
  // The pre-hash is unconditional on this path: besides the cache
  // key, it is the content-adoption identity (fire-pdf's
  // POST /jobs/lookup) and it verifies a fire-engine handoff
  // before the server-side copy. Uncacheable requests (maxPages)
  // skip only the cache LOOKUP — they still adopt. A failed
  // pre-hash falls through to the upload path (which hashes
  // in-pipeline), never errors the scrape.
  const handoff = meta.pdfPrefetch?.gcsReference;
  const { cacheable: byRefCacheable } = cacheKeyShape(
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
  );
  // asSignal() after an abort returns a signal whose listeners never
  // fire — check the manager directly (outside the swallowing catch
  // below) so an already-cancelled scrape doesn't stream-read the whole
  // file first.
  meta.abort.throwIfAborted();
  let localSha256: string | undefined;
  try {
    localSha256 = await sha256OfFile(tempFilePath, meta.abort.asSignal());
  } catch (error) {
    meta.logger.warn(
      "Pre-upload hash of large PDF failed; continuing without cache lookup",
      {
        method: "scrapePDF/firePdfByReference",
        error,
        scrape_id: meta.id,
      },
    );
  }
  const cachedByRef =
    byRefCacheable && localSha256
      ? await tryGetCached(
          meta,
          { key: `raw-${localSha256}` },
          mode,
          maxPages,
          pagesEstimate,
          includePageMarkdown,
          includeBlocks,
          pageMarkers,
        )
      : null;
  // A scrape cancelled during the hash/lookup must not return a
  // success out of the cache.
  meta.abort.throwIfAborted();
  if (cachedByRef) {
    return cachedByRef;
  }

  // Content adoption, still BEFORE upload: retries carry fresh
  // scrape_ids, so fire-pdf's scrape_id idempotency can't join
  // them to a job an earlier attempt started (and, by design,
  // never cancelled — see the async module's cancel policy). If a
  // job for these exact bytes+options is live or done, poll IT:
  // no upload, no duplicate processing. On success the result is
  // saved under the raw-sha cache key, so the attempt after next
  // is a pure cache hit. If the adopted job dies (expired/failed)
  // or fire-pdf errors, fall through to a fresh upload+submit —
  // except when the failure says this caller's own budget is
  // gone, where a fresh submit could not succeed either.
  if (localSha256) {
    const adoptable = await lookupAdoptableFirePdfJob(
      meta,
      localSha256,
      buildFirePdfJobOptions({
        maxPages,
        pagesProcessed: pagesEstimate,
        mode,
        includePageMarkdown,
        includeBlocks,
        pageMarkers,
      }),
    );
    meta.abort.throwIfAborted();
    if (adoptable) {
      try {
        return await scrapePDFWithFirePDFAsync(
          {
            ...meta,
            logger: meta.logger.child({
              method: "scrapePDF/firePDFAsyncAdopted",
            }),
          },
          adoptable,
          maxPages,
          pagesEstimate,
          mode,
          undefined,
          includePageMarkdown,
          includeBlocks,
          pageMarkers,
        );
      } catch (error) {
        // An aborted scrape must not fall through to a fresh
        // upload+submit (covers every abort shape without
        // matching error classes).
        meta.abort.throwIfAborted();
        if (
          error instanceof FirePdfAsyncFailure &&
          (error.reason === "polling_timeout" ||
            error.reason === "deadline_too_close")
        ) {
          throw error;
        }
        meta.logger.warn(
          "Adopted FirePDF job did not deliver; submitting fresh",
          {
            method: "scrapePDF/firePDFAsyncAdopted",
            event: "fire_pdf_adoption_fallthrough",
            error,
            adopted_scrape_id: adoptable.adoptScrapeId,
            scrape_id: meta.id,
          },
        );
      }
    }
  }

  // When fire-engine already handed the file off via GCS, a server-side
  // rewrite moves it into the fire-pdf input bucket without the bytes
  // transiting this process; otherwise (or if the rewrite fails)
  // stream-upload the local temp file. The handoff hash becomes
  // fire-pdf's idempotency identity, so it must match the raw-byte sha
  // already computed for the cache check above (no second disk read
  // needed); any mismatch falls back to the hashing upload.
  const handoffShaMatches =
    localSha256 !== undefined &&
    handoff?.sha256 !== undefined &&
    handoff.sha256.toLowerCase() === localSha256;
  if (
    localSha256 !== undefined &&
    handoff?.sha256 !== undefined &&
    !handoffShaMatches
  ) {
    meta.logger.warn(
      "fire-engine handoff sha256 does not match local bytes; using streaming upload",
      {
        method: "scrapePDF/firePdfByReference",
        event: "fire_pdf_handoff_sha_mismatch",
        scrape_id: meta.id,
      },
    );
  }
  const rewriteEligible =
    handoffShaMatches &&
    handoff !== undefined &&
    handoff.sizeBytes === fileSizeBytes;
  const uploaded =
    (rewriteEligible && handoff
      ? await rewritePdfInputForFirePdf(meta, {
          uri: handoff.uri,
          // rewriteEligible implies handoffShaMatches implies defined
          sha256: localSha256!,
          sizeBytes: fileSizeBytes,
          generation: handoff.generation,
        })
      : null) ??
    // A distinct key when a rewrite was attempted: a timed-out
    // copy may still complete and must never overwrite this
    // upload.
    (await uploadPdfInputForFirePdf(meta, tempFilePath, fileSizeBytes, {
      keyVariant: rewriteEligible ? "s" : undefined,
      precomputedSha256: localSha256,
    }));
  if (!uploaded) {
    // Upload failure: the caller falls through to the legacy chain — its
    // oversized-skip warning still fires, preserving the
    // pre-by-reference behavior.
    return null;
  }

  try {
    return await scrapePDFWithFirePDFAsync(
      {
        ...meta,
        logger: meta.logger.child({
          method: "scrapePDF/firePDFAsyncByReference",
        }),
      },
      uploaded,
      maxPages,
      pagesEstimate,
      mode,
      undefined,
      includePageMarkdown,
      includeBlocks,
      pageMarkers,
    );
  } catch (error) {
    // No inline retry exists at this size, and the legacy chain
    // below would silently degrade a large document to text-only
    // extraction. Surface the failure instead.
    meta.logger.error(
      "FirePDF by-reference scrape failed (no fallback at this size)",
      {
        method: "scrapePDF/firePDFAsyncByReference",
        error,
        file_size_bytes: fileSizeBytes,
        scrape_id: meta.id,
        team_id: meta.internalOptions.teamId,
      },
    );
    throw error;
  }
}
