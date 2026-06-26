import { Meta } from "../../..";
import { config } from "../../../../../config";
import { fetch as undiciFetch } from "undici";
import type { PDFProcessorResult } from "../types";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { safeMarkdownToHtml } from "../markdownToHtml";
import { scrapePDFWithFirePDF } from "../firePDF";
import { firePdfAsyncTotalDurationSeconds } from "./metrics";
import { POLL_FLOOR_MS, POLL_TIMEOUT_BUFFER_MS } from "./schema";
import { defaultSleep, computeDeadlineMs } from "./utils";
import { tryGetCached, maybeSaveResult } from "./cache";
import { submitJob } from "./submit";
import { pollUntilTerminal } from "./poll";
import { fetchResult } from "./result";

export { FirePdfAsyncFailure } from "./utils";

type FirePdfAsyncDeps = {
  fetchImpl?: typeof undiciFetch;
  fallbackImpl?: typeof scrapePDFWithFirePDF;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  nowImpl?: () => number;
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

  const cached = await tryGetCached(
    meta,
    base64Content,
    mode,
    maxPages,
    pagesProcessed,
  );
  if (cached) return cached;

  meta.abort.throwIfAborted();

  const baseUrl = config.FIRE_PDF_BASE_URL;
  if (!baseUrl) {
    // Should be unreachable — call site checks this — but fall back rather
    // than crash if a route somehow bypasses the gate.
    return fallbackImpl(meta, base64Content, maxPages, pagesProcessed, mode);
  }

  const overallStartedAt = now();
  const submitTime = now();
  const deadlineFromNow = computeDeadlineMs(meta.abort.scrapeTimeout());
  const deadlineAt = new Date(submitTime + deadlineFromNow).toISOString();
  const pollingDeadline = submitTime + deadlineFromNow + POLL_TIMEOUT_BUFFER_MS;

  // ── Step 1: POST /jobs ────────────────────────────────────────────────
  const submit = await submitJob({
    meta,
    baseUrl,
    base64Content,
    maxPages,
    pagesProcessed,
    mode,
    deadlineAt,
    fetchImpl,
  });

  // ── Step 2: poll until terminal (skip on idempotent-replay done) ──────
  const polled = submit.alreadyDone
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
      });

  // ── Step 3: GET /jobs/:id/result ──────────────────────────────────────
  const fetched = await fetchResult({
    baseUrl,
    scrapeId: meta.id,
    meta,
    fetchImpl,
    sleep,
  });

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
