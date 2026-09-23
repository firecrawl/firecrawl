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
import { safeMarkdownToHtml } from "../markdownToHtml";
import type { PDFProcessorResult } from "../types";
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
    result: cachedResultSchema,
  }),
  z.object({
    outcome: z.literal("stale"),
    key: z.string(),
    variant: z.string(),
    campaign: z.string(),
    result: cachedResultSchema,
  }),
  z.object({
    outcome: z.literal("miss"),
    reason: z.string(),
    key: z.string().optional(),
    campaign: z.string().optional(),
  }),
]);

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
  let answer: z.infer<typeof lookupOutcomeSchema>;
  try {
    answer = await robustFetch({
      url: `${config.FIRE_PDF_CACHE_BASE_URL}/cache/lookup`,
      method: "POST",
      headers: config.FIRE_PDF_API_KEY
        ? { Authorization: `Bearer ${config.FIRE_PDF_API_KEY}` }
        : undefined,
      body: {
        keys: await cacheLookupKeys(input),
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
    firePdfCacheEventsTotal.inc({
      event: answer.reason === "refresh" ? "bypass_refresh" : "miss",
      variant: ownVariant,
    });
    return null;
  }
  const { result } = answer;
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
