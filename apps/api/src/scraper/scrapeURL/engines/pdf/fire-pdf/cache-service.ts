import crypto from "crypto";
import { z } from "zod";
import type { Meta } from "../../..";
import { config } from "../../../../../config";
import {
  createPdfCacheKey,
  type PdfCacheKeyInput,
} from "../../../../../lib/gcs-pdf-cache";
import type { PDFMode } from "../../../../../controllers/v2/types";
import { robustFetch } from "../../../lib/fetch";
import {
  recordSpanException,
  type Span,
  setSpanAttributes,
  withSpan,
} from "../../../../../lib/otel-tracer";
import { safeMarkdownToHtml } from "../markdownToHtml";
import type { PDFProcessorResult } from "../types";
import {
  refreshOptionsForVariant,
  submitBackgroundRefresh,
} from "./background-refresh";
import { firePdfCacheEventsTotal } from "./metrics";
import { recordRefreshDecision } from "./refresh-budget";
import { type FirePdfSourceKind, firePdfRequestKind } from "./request-metadata";
import { firePdfBlocksSchema, firePdfPagesSchema } from "./schema";

/** fire-pdf answers cache lookups itself when this is set, and writes the entries. */
export function cacheServiceConfigured(): boolean {
  return !!config.FIRE_PDF_CACHE_BASE_URL;
}

/** Keys the document may be cached under: the bytes' hash first, then the historical hash of the base64 payload. */
async function cacheLookupKeys(input: PdfCacheKeyInput): Promise<string[]> {
  if (typeof input !== "string") return [input.key];
  // The bytes' hash runs off the event loop; the payload hash is the one the bucket path already paid.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Buffer.from(input, "base64"),
  );
  return [
    `raw-${Buffer.from(digest).toString("hex")}`,
    createPdfCacheKey(input),
  ];
}

// The service's own read bound, so a lookup never waits longer than the
// service would; past it the lookup is a miss and the document is parsed. One
// retry, within the same bound, covers a connection that dropped before the
// request was handled.
const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_TRIES = 2;

const cachedResultSchema = z.object({
  markdown: z.string(),
  pages_processed: z.number().int().nonnegative().optional(),
  pages: firePdfPagesSchema,
  blocks: firePdfBlocksSchema,
  // Present on entries written under a page-marker variant; the proof a
  // marker request needs, as the echo is on a fresh parse.
  page_markers: z.literal(true).optional(),
});

const lookupOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("hit"),
    key: z.string(),
    variant: z.string(),
    generation: z.string().optional(),
    result: cachedResultSchema,
  }),
  z.object({
    outcome: z.literal("stale"),
    key: z.string(),
    variant: z.string(),
    generation: z.string().optional(),
    campaign: z.string(),
    capped: z.boolean().optional(),
    // Only with `background_refresh` on the lookup: the service granted a
    // refresh and expects this client, which holds the bytes, to submit it.
    refresh_requested: z.boolean().optional(),
    result: cachedResultSchema,
  }),
  z.object({
    outcome: z.literal("miss"),
    reason: z.string(),
    key: z.string().optional(),
    campaign: z.string().optional(),
  }),
]);

// An index entry and the content-cache entry it was built from are written
// moments apart; only an entry written well after the index row is a newer
// parse rather than the same one.
const SUPERSEDE_MARGIN_MS = 15 * 60 * 1000;
const SUPERSEDE_TIMEOUT_MS = 1_000;

const supersedeAnswerSchema = z.object({
  outcome: z.string(),
  cached_at: z.string().optional(),
});

/**
 * Whether the cache service holds a fresh (no campaign match) entry for
 * `key` written after `indexCreatedAt`. Asks by key alone, so no bytes are
 * fetched and nothing is parsed. Any failure is "error": the caller keeps
 * serving the index copy.
 */
export async function checkFirePdfSupersedes(
  meta: Meta,
  key: string,
  indexCreatedAt: Date,
): Promise<"superseded" | "current" | "error"> {
  try {
    const answer = await robustFetch({
      url: `${config.FIRE_PDF_CACHE_BASE_URL}/cache/lookup`,
      method: "POST",
      headers: config.FIRE_PDF_API_KEY
        ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
        : undefined,
      body: {
        keys: [key],
        options: {},
        team_id: meta.internalOptions.teamId,
        kind: firePdfRequestKind(meta),
        source_kind: "pdf",
        scrape_id: meta.id,
      },
      schema: supersedeAnswerSchema,
      logger: meta.logger,
      mock: meta.mock,
      tryCount: 1,
      abort: AbortSignal.any([
        meta.abort.asSignal(),
        AbortSignal.timeout(SUPERSEDE_TIMEOUT_MS),
      ]),
    });
    if (answer.outcome !== "hit" || answer.cached_at === undefined) {
      return "current";
    }
    const cachedAt = new Date(answer.cached_at).getTime();
    if (isNaN(cachedAt)) return "current";
    return cachedAt - indexCreatedAt.getTime() > SUPERSEDE_MARGIN_MS
      ? "superseded"
      : "current";
  } catch (error) {
    meta.abort.throwIfAborted();
    meta.logger.warn("FirePDF supersede check failed, serving index copy", {
      scrapeId: meta.id,
      error,
    });
    return "error";
  }
}

export async function lookupCachedResult(
  meta: Meta,
  input: PdfCacheKeyInput,
  args: {
    mode: PDFMode | undefined;
    pagesProcessed: number | undefined;
    includePageMarkdown: boolean;
    includeBlocks: boolean;
    pageMarkers: boolean;
    refresh: boolean;
    sourceKind: FirePdfSourceKind;
    /** The variant this request would write, for the miss labels. */
    ownVariant: string;
  },
): Promise<PDFProcessorResult | null> {
  return withSpan("pdf.cache_lookup", span =>
    lookupWithinSpan(span, meta, input, args),
  );
}

async function lookupWithinSpan(
  span: Span,
  meta: Meta,
  input: PdfCacheKeyInput,
  args: Parameters<typeof lookupCachedResult>[2],
): Promise<PDFProcessorResult | null> {
  const {
    mode,
    pagesProcessed,
    includePageMarkdown,
    includeBlocks,
    pageMarkers,
    refresh,
    sourceKind,
    ownVariant,
  } = args;
  // An already-cancelled scrape sends nothing.
  meta.abort.throwIfAborted();
  // Background refresh is only offered when this client could act on a
  // grant: it needs the bytes (inline, not by reference) of a PDF (images
  // are only parsed through the sync endpoint), outside zero data retention.
  const canRefreshInBackground =
    config.FIRE_PDF_CACHE_BACKGROUND_REFRESH === true &&
    typeof input === "string" &&
    sourceKind === "pdf" &&
    meta.internalOptions.zeroDataRetention !== true;
  const keys = await cacheLookupKeys(input);
  if (
    sourceKind === "pdf" &&
    keys[0].startsWith("raw-") &&
    meta.firePdfCacheKey !== undefined
  ) {
    meta.firePdfCacheKey.current = keys[0];
  }
  let answer: z.infer<typeof lookupOutcomeSchema>;
  try {
    answer = await robustFetch({
      url: `${config.FIRE_PDF_CACHE_BASE_URL}/cache/lookup`,
      method: "POST",
      headers: config.FIRE_PDF_API_KEY
        ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
        : undefined,
      body: {
        keys,
        options: {
          ...(mode !== undefined && { mode }),
          ...(includePageMarkdown && { include_page_markdown: true }),
          ...(includeBlocks && { include_blocks: true }),
          ...(pageMarkers && { page_markers: true }),
        },
        team_id: meta.internalOptions.teamId,
        kind: firePdfRequestKind(meta),
        refresh,
        source_kind: sourceKind,
        scrape_id: meta.id,
        ...(canRefreshInBackground && { background_refresh: true }),
      },
      schema: lookupOutcomeSchema,
      logger: meta.logger,
      mock: meta.mock,
      tryCount: LOOKUP_TRIES,
      abort: AbortSignal.any([
        meta.abort.asSignal(),
        AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    // The scrape's own abort is not a lookup failure.
    meta.abort.throwIfAborted();
    firePdfCacheEventsTotal.inc({ event: "lookup_error", variant: ownVariant });
    setSpanAttributes(span, { "pdf.cache_outcome": "error" });
    recordSpanException(span, error);
    meta.logger.warn("FirePDF cache lookup failed, proceeding", {
      scrapeId: meta.id,
      error,
    });
    return null;
  }

  // The service took the refresh decision; a fallback engine must reuse it
  // rather than spend a second token or serve what was meant to be bypassed.
  if (refresh) {
    recordRefreshDecision(
      meta.id,
      answer.outcome === "miss" && answer.reason === "refresh"
        ? "allowed"
        : "limited",
    );
  }
  if (answer.outcome === "miss") {
    setSpanAttributes(span, {
      "pdf.cache_outcome": "miss",
      "pdf.cache_reason": answer.reason,
      "pdf.cache_campaign": answer.campaign,
    });
    firePdfCacheEventsTotal.inc({
      event: answer.reason === "refresh" ? "bypass_refresh" : "miss",
      variant: ownVariant,
    });
    return null;
  }
  const { result } = answer;
  setSpanAttributes(span, {
    "pdf.cache_outcome": answer.outcome,
    "pdf.cache_reason":
      answer.outcome === "stale"
        ? answer.capped
          ? "capped"
          : "campaign"
        : "served",
    "pdf.cache_variant": answer.variant,
    "pdf.cache_generation": answer.generation,
    ...(answer.outcome === "stale" && {
      "pdf.cache_campaign": answer.campaign,
    }),
  });
  // Never an unusable entry, whatever the service says: a sidecar the request
  // needs must be present, a marker request needs a marker entry, and an
  // empty result for a raster image is a stale verdict, not an answer (see
  // isRasterImagePayload in cache.ts).
  if (
    (includePageMarkdown && result.pages === undefined) ||
    (includeBlocks && result.blocks === undefined) ||
    (pageMarkers && result.page_markers !== true) ||
    (sourceKind === "image" && result.markdown.trim().length === 0)
  ) {
    setSpanAttributes(span, {
      "pdf.cache_outcome": "miss",
      "pdf.cache_reason": "unusable",
    });
    firePdfCacheEventsTotal.inc({ event: "miss", variant: ownVariant });
    return null;
  }
  firePdfCacheEventsTotal.inc({
    event: answer.outcome,
    variant: answer.variant,
  });
  meta.logger.info("Using cached FirePDF result", {
    scrapeId: meta.id,
    requestedMode: mode,
    cacheVariant: answer.variant,
    cacheKey: answer.key,
    outcome: answer.outcome,
    ...(answer.outcome === "stale" && { campaign: answer.campaign }),
  });
  // Never awaited: the stale entry is served now, the refresh lands later.
  if (
    canRefreshInBackground &&
    answer.outcome === "stale" &&
    answer.refresh_requested === true
  ) {
    void submitBackgroundRefresh(meta, input, {
      ...refreshOptionsForVariant(answer.variant, mode),
      sourceKind,
    });
  }
  // The entry carries markdown only; html is rendered here as on a fresh parse.
  return {
    markdown: result.markdown,
    html: await safeMarkdownToHtml(result.markdown, meta.logger, meta.id),
    pagesProcessed: result.pages_processed ?? pagesProcessed,
    ...(includePageMarkdown && result.pages
      ? { pageMarkdown: result.pages }
      : {}),
    ...(includeBlocks && result.blocks ? { blocks: result.blocks } : {}),
  };
}
