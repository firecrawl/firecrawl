import crypto from "crypto";
import { fetch as undiciFetch } from "undici";
import type { Meta } from "../../..";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { config } from "../../../../../config";
import type { PdfCacheKeyInput } from "../../../../../lib/gcs-pdf-cache";
import {
  type BackgroundRefreshResult,
  firePdfCacheBackgroundRefreshTotal,
} from "./metrics";
import {
  buildFirePdfRequestMetadata,
  type FirePdfSourceKind,
} from "./request-metadata";
import { MAX_DEADLINE_MS } from "./schema";
import { buildFirePdfJobOptions, firePdfHeaders } from "./utils";

/**
 * The crawl id every background refresh is submitted under. fire-pdf queues
 * any job with a crawl id on its bulk (lowest priority) queues, and paces
 * bulk publishing round-robin across crawl ids, so one shared id keeps all
 * refreshes together as a single crawl's worth of work behind real crawls.
 * Firecrawl crawl ids are UUIDs, so this can never name a real crawl.
 */
export const BACKGROUND_REFRESH_CRAWL_ID = "fire-pdf-cache-refresh";

// Nobody waits on a refresh: advertise the longest deadline fire-pdf accepts
// (POST /jobs rejects anything further out as deadline_too_far).
const REFRESH_DEADLINE_MS = MAX_DEADLINE_MS;
// Bounds only the submit request itself, never the job.
const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * The job options that re-create the variant the cache service served. A
 * lookup may be answered from a richer or OCR variant than the request would
 * write, and that served variant is the one to refresh. Variant names follow
 * fire-pdf's lattice (cache.ts cacheKeyShape): an `ocr` prefix, and
 * `page-markdown`, `blocks` and `markers` capabilities.
 */
export function refreshOptionsForVariant(
  variant: string,
  requestMode: PDFMode | undefined,
): {
  mode: PDFMode | undefined;
  includePageMarkdown: boolean;
  includeBlocks: boolean;
  pageMarkers: boolean;
} {
  return {
    mode: variant.startsWith("ocr") ? "ocr" : requestMode,
    includePageMarkdown: variant.includes("page-markdown"),
    includeBlocks: variant.includes("blocks"),
    pageMarkers: variant.includes("markers"),
  };
}

/**
 * Submits a fresh parse of a document the cache service answered stale with
 * `refresh_requested: true`. Fire-and-forget: the scrape has already been
 * served the stale entry, this is never awaited by it, never polls, and never
 * throws. fire-pdf writes the fresh entry itself when the job completes.
 *
 * Built from the same pieces as the async submit (submit.ts) but sent once
 * without its retry and fallback handling, which counts into the async
 * fallback metrics and is bound to the scrape's abort signal. The job:
 *   - uses a fresh scrape_id, so it can never collide with the caller's job;
 *   - carries `options.refresh`, so fire-pdf parses rather than answering
 *     from the cache, with the options of the variant that was served stale
 *     (refreshOptionsForVariant), so it rewrites that entry;
 *   - carries BACKGROUND_REFRESH_CRAWL_ID, so it lands on the bulk queue;
 *   - carries no team_id (nor team_concurrency): it is internal work the
 *     cache tier budgeted, so it must not count against the requesting
 *     team's admission counters or allowance. The requesting team and scrape
 *     are logged here for tracing instead.
 * Nothing in Firecrawl bills it: its result never comes back to a scrape.
 */
export function submitBackgroundRefresh(
  meta: Meta,
  input: PdfCacheKeyInput,
  args: {
    mode: PDFMode | undefined;
    includePageMarkdown: boolean;
    includeBlocks: boolean;
    pageMarkers: boolean;
    sourceKind: FirePdfSourceKind;
  },
  fetchImpl: typeof undiciFetch = undiciFetch,
): Promise<BackgroundRefreshResult> {
  return submit(meta, input, args, fetchImpl)
    .catch(error => {
      meta.logger.warn("FirePDF background refresh submit failed", {
        scrapeId: meta.id,
        error,
      });
      return "submit_failed" as const;
    })
    .then(result => {
      firePdfCacheBackgroundRefreshTotal.inc({ result });
      return result;
    });
}

async function submit(
  meta: Meta,
  input: PdfCacheKeyInput,
  args: Parameters<typeof submitBackgroundRefresh>[2],
  fetchImpl: typeof undiciFetch,
): Promise<BackgroundRefreshResult> {
  if (meta.internalOptions.zeroDataRetention === true) return "skipped_zdr";
  // A by-reference document's bytes are in fire-pdf's input bucket, not here.
  if (typeof input !== "string") return "skipped_by_reference";
  // Raster images are only ever parsed through the sync endpoint.
  if (args.sourceKind === "image") return "skipped_image";
  if (!config.FIRE_PDF_BASE_URL) {
    throw new Error("FIRE_PDF_BASE_URL is not set");
  }

  const refreshScrapeId = crypto.randomUUID();
  const resp = await fetchImpl(`${config.FIRE_PDF_BASE_URL}/jobs`, {
    method: "POST",
    headers: firePdfHeaders(true),
    body: JSON.stringify({
      pdf_b64: input,
      scrape_id: refreshScrapeId,
      source: "firecrawl",
      ...buildFirePdfRequestMetadata(meta, args.sourceKind),
      zdr: false,
      deadline_at: new Date(Date.now() + REFRESH_DEADLINE_MS).toISOString(),
      crawl_id: BACKGROUND_REFRESH_CRAWL_ID,
      options: {
        ...buildFirePdfJobOptions({
          maxPages: undefined,
          pagesProcessed: undefined,
          mode: args.mode,
          includePageMarkdown: args.includePageMarkdown,
          includeBlocks: args.includeBlocks,
          pageMarkers: args.pageMarkers,
          // The cache is only consulted without an explicit table format.
          tableFormat: undefined,
          // Internal work under no team: never offered for training capture.
          trainingCapture: undefined,
        }),
        refresh: true,
      },
    }),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (resp.status !== 200 && resp.status !== 202) {
    meta.logger.warn("FirePDF background refresh rejected", {
      scrapeId: meta.id,
      refreshScrapeId,
      status: resp.status,
      body,
    });
    return "submit_failed";
  }
  meta.logger.info("FirePDF background refresh submitted", {
    scrapeId: meta.id,
    refreshScrapeId,
    teamId: meta.internalOptions.teamId,
    httpStatus: resp.status,
  });
  return "submitted";
}
