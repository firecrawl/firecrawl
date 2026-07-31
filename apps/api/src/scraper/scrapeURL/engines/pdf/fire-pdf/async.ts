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
  base64Content: string,
  maxPages?: number,
  pagesProcessed?: number,
  mode?: PDFMode,
  deps: FirePdfAsyncDeps = {},
): Promise<PDFProcessorResult> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch;
  const fallbackImpl = deps.fallbackImpl ?? scrapePDFWithFirePDF;
  const sleep = deps.sleepImpl ?? defaultSleep;
  const now = deps.nowImpl ?? Date.now;
  const random = deps.randomImpl ?? Math.random;

  // Async persists inputs and queue state, so ZDR is excluded until that
  // lifecycle has an explicit delete-on-completion contract.
  if (meta.internalOptions.zeroDataRetention) {
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  }

  const cached = await tryGetCached(
    meta,
    base64Content,
    mode,
    maxPages,
    pagesProcessed,
  );
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
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  }

  const overallStartedAt = now();
  const submitTime = now();
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
      base64Content,
      maxPages,
      pagesProcessed,
      mode,
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
  const durationMs = now() - overallStartedAt;
  firePdfAsyncTotalDurationSeconds.observe(durationMs / 1000);

  meta.logger.info("FirePDF async completed", {
    scrapeId: meta.id,
    durationMs,
    markdownLength: fetched.markdown.length,
    pagesProcessed: pages,
    failedPages: fetched.failed_pages,
    partialPages: fetched.partial_pages,
    pollCount: polled.pollCount,
  });

  const processorResult: PDFProcessorResult & { markdown: string } = {
    markdown: fetched.markdown,
    html: await safeMarkdownToHtml(fetched.markdown, meta.logger, meta.id),
    pagesProcessed: pages,
  };

  await maybeSaveResult({
    meta,
    base64Content,
    mode,
    maxPages,
    result: processorResult,
  });

  return processorResult;
}
