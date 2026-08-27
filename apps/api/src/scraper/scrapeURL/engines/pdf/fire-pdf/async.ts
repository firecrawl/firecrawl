import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { config } from "../../../../../config";
import { fetch as undiciFetch } from "undici";
import type { PDFProcessorResult } from "../types";
import { safeMarkdownToHtml } from "../markdownToHtml";
import { scrapePDFWithFirePDF } from "../firePDF";
import { cancelJob } from "./cancel";
import { tryGetCached, maybeSaveResult } from "./cache";
import { firePdfAsyncTotalDurationSeconds } from "./metrics";
import { pollUntilTerminal } from "./poll";
import { fetchResult } from "./result";
import type { FirePdfByReferenceInput } from "./by-reference";
import type { FirePdfAdoptedJobInput } from "./lookup";
import { FIRE_PDF_ASYNC_MIN_REMAINING_MS } from "./routing";
import { POLL_FLOOR_MS, POLL_TIMEOUT_BUFFER_MS } from "./schema";
import { submitJob, SubmitJobMayHaveBeenAcceptedError } from "./submit";
import {
  computeByReferenceDeadlineMs,
  computeDeadlineMs,
  defaultSleep,
  failAsync,
  FirePdfAsyncFailure,
} from "./utils";

export { FirePdfAsyncFailure };

type FirePdfAsyncDeps = {
  fetchImpl?: typeof undiciFetch;
  fallbackImpl?: typeof scrapePDFWithFirePDF;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowImpl?: () => number;
  randomImpl?: () => number;
};

export async function scrapePDFWithFirePDFAsync(
  meta: Meta,
  /** Inline base64 (string, the historical shape), a pre-uploaded GCS
   * reference for large files, or an existing job to adopt (found by
   * content lookup — no upload, no submit, just poll + fetch). Neither
   * non-string form has a sync fallback — the bytes don't fit fire-pdf's
   * inline paths — so infra fallbacks below only apply to the string
   * form. */
  input: string | FirePdfByReferenceInput | FirePdfAdoptedJobInput,
  maxPages?: number,
  pagesProcessed?: number,
  mode?: PDFMode,
  deps: FirePdfAsyncDeps = {},
  includePageMarkdown = false,
  includeBlocks = false,
  pageMarkers = false,
): Promise<PDFProcessorResult> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch;
  const fallbackImpl = deps.fallbackImpl ?? scrapePDFWithFirePDF;
  const sleep = deps.sleepImpl ?? defaultSleep;
  const now = deps.nowImpl ?? Date.now;
  const random = deps.randomImpl ?? Math.random;
  const base64Content = typeof input === "string" ? input : undefined;
  const adopted =
    typeof input !== "string" && "adoptScrapeId" in input ? input : undefined;
  const byReference =
    typeof input !== "string" && "gcsUri" in input ? input : undefined;
  // Which fire-pdf job this attempt watches: our own scrape_id, or the
  // adopted job's. Poll, result-fetch, and cancel must all agree.
  const jobScrapeId = adopted ? adopted.adoptScrapeId : meta.id;

  // Async persists inputs and queue state, so ZDR is excluded until that
  // lifecycle has an explicit delete-on-completion contract.
  if (meta.internalOptions.zeroDataRetention) {
    if (base64Content === undefined) {
      // By-reference already persisted the input object, and adoption
      // reads another submitter's persisted job; the routing layer must
      // never send ZDR traffic here.
      throw new Error(
        "fire-pdf by-reference submit is not available under zero data retention",
      );
    }
    return fallbackImpl(
      meta,
      base64Content,
      maxPages,
      pagesProcessed,
      mode,
      includePageMarkdown,
      includeBlocks,
      pageMarkers,
    );
  }

  // Cache addressing: inline submits keep the historical key (sha256 of
  // the base64 payload); by-reference submits use a `raw-` prefixed key
  // over the raw-byte sha, so repeat scrapes of the same large document
  // don't reprocess it. The two keyspaces are deliberately distinct — an
  // inline and a by-reference parse of the same document do not share
  // entries. The LOOKUP for by-reference happens at the call site BEFORE
  // the input object is uploaded (a hit must skip the 30-256MB transfer,
  // which has already happened by the time this function runs); only the
  // inline path looks up here. Both paths save here.
  const cacheInput =
    typeof input === "string"
      ? input
      : { key: `raw-${input.sha256.toLowerCase()}` };
  const cached =
    typeof input === "string"
      ? await tryGetCached(
          meta,
          cacheInput,
          mode,
          maxPages,
          pagesProcessed,
          includePageMarkdown,
          includeBlocks,
          pageMarkers,
        )
      : null;
  if (cached) return cached;

  meta.abort.throwIfAborted();

  const remainingMs = meta.abort.scrapeTimeout();
  if (
    remainingMs !== undefined &&
    remainingMs < FIRE_PDF_ASYNC_MIN_REMAINING_MS
  ) {
    failAsync(meta, "deadline_too_close", { remainingMs });
  }

  const baseUrl = config.FIRE_PDF_BASE_URL;
  if (!baseUrl) {
    // Should be unreachable — call site checks this — but fall back rather
    // than crash if a route somehow bypasses the gate.
    if (base64Content === undefined) {
      throw new Error(
        "fire-pdf by-reference submit requires FIRE_PDF_BASE_URL",
      );
    }
    return fallbackImpl(
      meta,
      base64Content,
      maxPages,
      pagesProcessed,
      mode,
      includePageMarkdown,
      includeBlocks,
      pageMarkers,
    );
  }

  const overallStartedAt = now();
  const submitTime = now();
  // The caller's window governs how long THIS attempt polls: scrapeURLLoop
  // kills no-timeout scrapes at 5 minutes regardless of what the job is
  // allowed, so polling past it only burns a dead scrape's cycles.
  const callerWindowMs = computeDeadlineMs(remainingMs);
  // The JOB deadline is decoupled from the caller for by-reference
  // submits: page-scaled, never below the caller window, capped at
  // 30 min. An inline job's deadline stays the caller window exactly —
  // when its caller dies, the job is cancelled and the work discarded, so
  // advertising more time would be a lie. A by-reference job instead
  // outlives its caller on purpose (cancel is skipped below): it finishes
  // server-side, lands in the raw-sha cache and the content-adoption
  // lookup, and the customer's retry — with a fresh scrape_id — converges
  // instead of restarting a multi-minute document from zero. Callers
  // wanting first-attempt success must still pass an explicit `timeout`.
  const deadlineFromNow = byReference
    ? computeByReferenceDeadlineMs(remainingMs, pagesProcessed)
    : callerWindowMs;
  const deadlineAt = new Date(submitTime + deadlineFromNow).toISOString();
  const pollingDeadline = submitTime + callerWindowMs + POLL_TIMEOUT_BUFFER_MS;

  // Account context for FirePDF's per-team admission observation,
  // snapshotted from the request ACUC into internalOptions at
  // acceptance (same pattern as teamFlags) — no re-fetch here. Absence
  // means FirePDF skips team observation for this submit.
  const rawConcurrency = meta.internalOptions.teamConcurrency;
  const teamConcurrency =
    typeof rawConcurrency === "number" && rawConcurrency > 0
      ? rawConcurrency
      : undefined;

  // ── Step 1: POST /jobs (skipped when adopting an existing job) ────────
  let submissionAccepted = false;
  let terminalReached = false;
  let polled: Awaited<ReturnType<typeof pollUntilTerminal>>;
  let fetched: Awaited<ReturnType<typeof fetchResult>>;
  // What goes on the wire for step 1 — null means nothing does: an
  // adopted job was submitted by an earlier attempt and is only watched.
  const wireInput = byReference
    ? ({
        kind: "byReference",
        gcsUri: byReference.gcsUri,
        sha256: byReference.sha256,
      } as const)
    : base64Content !== undefined
      ? ({ kind: "inline", base64Content } as const)
      : null;
  // Ownership policy, in one place: only an abandoned INLINE job is
  // cancelled. An adopted job is not ours to kill — its owner or other
  // retries may still be watching. A by-reference job is left running BY
  // DESIGN: its input is durably content-addressed, so the completion
  // this caller never sees still lands in the raw-sha cache and the
  // adoption lookup, converting the customer's retry loop into a cache
  // hit. The cost is bounded — the job's own deadline (≤30 min) — and
  // strictly smaller than the redo loop it replaces.
  const cancelOnAbandon = wireInput?.kind === "inline";

  try {
    let alreadyDone = false;
    let initialDelay: number = POLL_FLOOR_MS;
    if (wireInput === null) {
      meta.logger.info("FirePDF async adopting existing job", {
        scrapeId: meta.id,
        adoptedScrapeId: jobScrapeId,
      });
      // Adopted jobs are live by definition (done ones return on the
      // first poll); the true start time is unknown, so the estimate
      // conservatively counts from now. Written into the shared
      // container so it survives the spread copies between here and the
      // outer timeout handler.
      if (meta.largePdfProcessing) {
        meta.largePdfProcessing.current = {
          jobScrapeId,
          pagesEstimate: pagesProcessed,
          submittedAtMs: submitTime,
          lastStatus: "running",
        };
      }
    } else {
      const submit = await submitJob({
        meta,
        baseUrl,
        input: wireInput,
        maxPages,
        pagesProcessed,
        mode,
        includePageMarkdown,
        includeBlocks,
        pageMarkers,
        deadlineAt,
        teamConcurrency,
        fetchImpl,
      });
      submissionAccepted = true;
      alreadyDone = submit.alreadyDone;
      initialDelay = submit.retryAfterMs ?? POLL_FLOOR_MS;
      if (byReference && !alreadyDone && meta.largePdfProcessing) {
        // The job now exists server-side and (per the cancel policy
        // above) will keep running if this scrape is abandoned — record
        // enough state for the timeout error to say so. Written into the
        // shared container so it survives the spread copies between here
        // and the outer timeout handler.
        meta.largePdfProcessing.current = {
          jobScrapeId,
          pagesEstimate: pagesProcessed,
          submittedAtMs: submitTime,
          jobDeadlineAtMs: submitTime + deadlineFromNow,
          lastStatus: "queued",
        };
      }
    }
    terminalReached = alreadyDone;

    // ── Step 2: poll until terminal (skip on idempotent-replay done) ──────
    polled = alreadyDone
      ? {
          poll: { scrape_id: jobScrapeId, status: "done" as const },
          pollCount: 0,
        }
      : await pollUntilTerminal({
          baseUrl,
          scrapeId: jobScrapeId,
          initialDelay,
          pollingDeadline,
          meta,
          fetchImpl,
          sleep,
          now,
          random,
          onNonTerminalStatus: (status, estimatedRemainingMs) => {
            const current = meta.largePdfProcessing?.current;
            if (!current) return;
            current.lastStatus = status;
            if (estimatedRemainingMs !== undefined) {
              current.serverEstimate = {
                remainingMs: estimatedRemainingMs,
                observedAtMs: now(),
              };
            }
          },
        });
    terminalReached = true;

    // ── Step 3: GET /jobs/:id/result ────────────────────────────────────
    fetched = await fetchResult({
      baseUrl,
      scrapeId: jobScrapeId,
      meta,
      fetchImpl,
      sleep,
    });
  } catch (error) {
    const submitMayHaveBeenAccepted =
      error instanceof SubmitJobMayHaveBeenAcceptedError;
    const jobAlreadyTerminal =
      error instanceof FirePdfAsyncFailure &&
      (error.reason === "terminal_failed" ||
        error.reason === "terminal_expired" ||
        error.reason === "terminal_cancelled");
    if ((jobAlreadyTerminal || terminalReached) && meta.largePdfProcessing) {
      // The job is dead — a "processing continues" message would lie.
      meta.largePdfProcessing.current = undefined;
    }
    if (
      cancelOnAbandon &&
      (submissionAccepted || submitMayHaveBeenAccepted) &&
      !terminalReached &&
      !jobAlreadyTerminal
    ) {
      await cancelJob({ baseUrl, scrapeId: meta.id, meta, fetchImpl });
    }
    throw submitMayHaveBeenAccepted ? error.originalError : error;
  }

  // The job reached a terminal state and its result was fetched — nothing
  // "continues", regardless of how the validations below turn out (their
  // failAsync throws must not leave stale processing state behind).
  if (meta.largePdfProcessing) {
    meta.largePdfProcessing.current = undefined;
  }

  // ── Assemble + cache save ─────────────────────────────────────────────
  const pages =
    fetched.pages_processed ?? polled.poll.pages_processed ?? pagesProcessed;
  if (includePageMarkdown && fetched.pages === undefined) {
    failAsync(meta, "http_5xx", {
      note: "FirePDF result omitted requested physical page markdown",
    });
  }
  if (includeBlocks && fetched.blocks === undefined) {
    failAsync(meta, "http_5xx", {
      note: "FirePDF result omitted requested typed blocks",
    });
  }
  if (pageMarkers && fetched.page_markers !== true) {
    // Markers are baked into the markdown, so the missing echo is the only
    // signal the worker build ignored the option; accepting the result
    // would cache unmarked markdown under a marker cache variant. Fail the
    // async attempt — the caller retries synchronously, where the same
    // echo contract applies.
    failAsync(meta, "http_5xx", {
      note: "FirePDF result did not acknowledge requested page markers",
    });
  }
  const durationMs = now() - overallStartedAt;
  firePdfAsyncTotalDurationSeconds.observe(durationMs / 1000);

  meta.logger.info("FirePDF async completed", {
    scrapeId: meta.id,
    durationMs,
    markdownLength: fetched.markdown.length,
    pagesProcessed: pages,
    pageMarkdownPages: fetched.pages?.length,
    blockPages: fetched.blocks?.length,
    failedPages: fetched.failed_pages,
    partialPages: fetched.partial_pages,
    pollCount: polled.pollCount,
  });

  const processorResult: PDFProcessorResult & { markdown: string } = {
    markdown: fetched.markdown,
    html: await safeMarkdownToHtml(fetched.markdown, meta.logger, meta.id),
    pagesProcessed: pages,
    ...(fetched.pages ? { pageMarkdown: fetched.pages } : {}),
    ...(fetched.blocks ? { blocks: fetched.blocks } : {}),
  };

  await maybeSaveResult({
    meta,
    base64Content: cacheInput,
    mode,
    maxPages,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
    result: processorResult,
  });

  return processorResult;
}
