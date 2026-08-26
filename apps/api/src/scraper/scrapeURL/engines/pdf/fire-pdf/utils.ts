import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { config } from "../../../../../config";
import { MAX_DEADLINE_MS, POLL_FLOOR_MS, POLL_CAP_MS } from "./schema";
import { firePdfAsyncFallbackTotal, type FallbackReason } from "./metrics";

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Aborted"),
      );
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(handle);
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("Aborted"),
        );
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function nextPollDelay(
  prev: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number {
  const candidate = Math.max(prev * 2, retryAfterMs ?? 0, POLL_FLOOR_MS);
  const jittered = Math.round(candidate * (1 + random() * 0.2));
  return Math.min(POLL_CAP_MS, jittered);
}

export function computeDeadlineMs(scrapeTimeoutMs: number | undefined): number {
  // 5min default when there's no scrape budget. This matches the usable
  // window exactly: scrapeURLLoop races every engine against
  // `scrapeTimeout() ?? 300000`, so a no-timeout scrape dies at 5 minutes
  // regardless of what we advertise to FirePDF. Long documents (large
  // by-reference PDFs especially) need an explicit caller `timeout`, which
  // unlocks up to MAX_DEADLINE_MS here and extends the loop's race alike.
  // Only cap the upper bound so we never advertise more time to FirePDF
  // than the caller actually has.
  const fallback = 5 * 60 * 1_000;
  const candidate = scrapeTimeoutMs ?? fallback;
  return Math.min(MAX_DEADLINE_MS, candidate);
}

/** Rough worst-case processing rate for the page-scaled by-reference
 * deadline. Prod xl-lane runs land well under this (a 6,543-page document
 * processed in ~29 minutes ≈ 270ms/page including queue wait); the slack
 * absorbs queue depth without pushing every big document to the 30-min
 * ceiling. */
const BY_REFERENCE_DEADLINE_PER_PAGE_MS = 500;
const BY_REFERENCE_DEADLINE_BASE_MS = 5 * 60 * 1_000;

/**
 * Job deadline for by-reference submits, DECOUPLED from the caller's
 * remaining budget: what the document needs (page-scaled), never less
 * than the caller's own window, capped at fire-pdf's 30-min maximum.
 *
 * Inline submits advertise exactly the caller window (computeDeadlineMs)
 * because an abandoned inline job is cancelled and its work discarded.
 * A by-reference job that outlives its caller is NOT discarded: the
 * async caller skips cancel-on-abandon, the job finishes server-side,
 * and the result lands in the raw-sha cache and the content-adoption
 * lookup — so the customer's retry converges instead of restarting a
 * multi-minute document from zero on every attempt.
 */
export function computeByReferenceDeadlineMs(
  scrapeTimeoutMs: number | undefined,
  pagesEstimate: number | undefined,
): number {
  const callerWindow = computeDeadlineMs(scrapeTimeoutMs);
  const pages =
    pagesEstimate !== undefined && pagesEstimate > 0 ? pagesEstimate : 0;
  const pageScaled =
    BY_REFERENCE_DEADLINE_BASE_MS + pages * BY_REFERENCE_DEADLINE_PER_PAGE_MS;
  return Math.min(MAX_DEADLINE_MS, Math.max(callerWindow, pageScaled));
}

/**
 * The `options` object for fire-pdf async wire calls. One builder for
 * both POST /jobs and POST /jobs/lookup: adoption matches on fire-pdf's
 * idempotency options, so a lookup that built its options differently
 * from the submit would silently never match.
 */
export function buildFirePdfJobOptions(args: {
  maxPages: number | undefined;
  pagesProcessed: number | undefined;
  mode: PDFMode | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers: boolean;
}): Record<string, unknown> {
  return {
    ...(args.pagesProcessed !== undefined && {
      pages_estimate: args.pagesProcessed,
    }),
    ...(args.maxPages !== undefined && { max_pages: args.maxPages }),
    ...(args.mode !== undefined && { mode: args.mode }),
    ...(args.includePageMarkdown && { include_page_markdown: true }),
    ...(args.includeBlocks && { include_blocks: true }),
    // Intentionally camelCase, unlike its siblings: the fire-pdf async
    // /jobs options schema named this key `pageMarkers` (fire-pdf
    // api/src/http/schemas/jobs.ts) while the sync /ocr path uses
    // `page_markers`. Sending snake_case here would be rejected as an
    // unknown option.
    ...(args.pageMarkers && { pageMarkers: true }),
  };
}

export function firePdfHeaders(includeJson = false): Record<string, string> {
  return {
    ...(includeJson && { "Content-Type": "application/json" }),
    ...(config.FIRE_PDF_API_KEY && {
      Authorization: `Bearer ${config.FIRE_PDF_API_KEY}`,
    }),
  };
}

export class FirePdfAsyncFailure extends Error {
  constructor(
    public readonly reason: FallbackReason,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(`fire-pdf async failed: ${reason}`);
    this.name = "FirePdfAsyncFailure";
  }
}

export function failAsync(
  meta: Meta,
  reason: FallbackReason,
  extra: Record<string, unknown> = {},
): never {
  firePdfAsyncFallbackTotal.labels(reason).inc();
  meta.logger.warn("FirePDF async failed", {
    scrapeId: meta.id,
    reason,
    ...extra,
  });
  throw new FirePdfAsyncFailure(reason, extra);
}
