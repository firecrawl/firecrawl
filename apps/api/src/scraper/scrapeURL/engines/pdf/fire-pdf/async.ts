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
import { FIRE_PDF_ASYNC_MIN_REMAINING_MS } from "./routing";
import { POLL_FLOOR_MS, POLL_TIMEOUT_BUFFER_MS } from "./schema";
import { submitJob, SubmitJobMayHaveBeenAcceptedError } from "./submit";
import {
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
  /** Inline base64 (string, the historical shape) or a pre-uploaded GCS
   * reference for large files. By-reference has no sync fallback — the
   * bytes don't fit fire-pdf's inline paths — so infra fallbacks below
   * only apply to the string form. */
  input: string | FirePdfByReferenceInput,
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

  // Async persists inputs and queue state, so ZDR is excluded until that
  // lifecycle has an explicit delete-on-completion contract.
  if (meta.internalOptions.zeroDataRetention) {
    if (base64Content === undefined) {
      // By-reference already persisted the input object; the routing layer
      // must never send ZDR traffic here.
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
  // Note for large by-reference documents: the no-budget fallback inside
  // computeDeadlineMs is 5 minutes because scrapeURLLoop kills no-timeout
  // scrapes at 5 minutes anyway. Callers wanting the full multi-minute
  // window for big documents must pass an explicit `timeout`.
  const deadlineFromNow = computeDeadlineMs(remainingMs);
  const deadlineAt = new Date(submitTime + deadlineFromNow).toISOString();
  const pollingDeadline = submitTime + deadlineFromNow + POLL_TIMEOUT_BUFFER_MS;

  // Account context for FirePDF's per-team admission observation,
  // snapshotted from the request ACUC into internalOptions at
  // acceptance (same pattern as teamFlags) — no re-fetch here. Absence
  // means FirePDF skips team observation for this submit.
  const rawConcurrency = meta.internalOptions.teamConcurrency;
  const teamConcurrency =
    typeof rawConcurrency === "number" && rawConcurrency > 0
      ? rawConcurrency
      : undefined;

  // ── Step 1: POST /jobs ────────────────────────────────────────────────
  let submissionAccepted = false;
  let terminalReached = false;
  let polled: Awaited<ReturnType<typeof pollUntilTerminal>>;
  let fetched: Awaited<ReturnType<typeof fetchResult>>;
  try {
    const submit = await submitJob({
      meta,
      baseUrl,
      input:
        typeof input === "string"
          ? { kind: "inline", base64Content: input }
          : {
              kind: "byReference",
              gcsUri: input.gcsUri,
              sha256: input.sha256,
            },
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
    terminalReached = submit.alreadyDone;

    // ── Step 2: poll until terminal (skip on idempotent-replay done) ──────
    polled = submit.alreadyDone
      ? {
          poll: { scrape_id: meta.id, status: "done" as const },
          pollCount: 0,
        }
      : await pollUntilTerminal({
          baseUrl,
          scrapeId: meta.id,
          initialDelay: submit.retryAfterMs ?? POLL_FLOOR_MS,
          pollingDeadline,
          meta,
          fetchImpl,
          sleep,
          now,
          random,
        });
    terminalReached = true;

    // ── Step 3: GET /jobs/:id/result ────────────────────────────────────
    fetched = await fetchResult({
      baseUrl,
      scrapeId: meta.id,
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
    if (
      (submissionAccepted || submitMayHaveBeenAccepted) &&
      !terminalReached &&
      !jobAlreadyTerminal
    ) {
      await cancelJob({ baseUrl, scrapeId: meta.id, meta, fetchImpl });
    }
    throw submitMayHaveBeenAccepted ? error.originalError : error;
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
