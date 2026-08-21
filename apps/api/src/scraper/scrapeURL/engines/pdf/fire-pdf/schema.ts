import { z } from "zod";

// Deadline constraints (`deadline_at - now` must fall in this window per the
// /jobs contract). Polling cadence — start at the response's `retry_after_ms`
// floor, exponential backoff capped at POLL_CAP_MS. Polling deadline budget
// = computed `deadline_at` + this buffer (defense in depth on top of the
// worker's own expiration handling).
export const MIN_DEADLINE_MS = 5_000;
export const MAX_DEADLINE_MS = 30 * 60 * 1_000;
export const POLL_FLOOR_MS = 1_000;
export const POLL_CAP_MS = 5_000;
export const POLL_TIMEOUT_BUFFER_MS = 30_000;

export const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "expired",
  "cancelled",
]);

export const submitResponseSchema = z.object({
  scrape_id: z.string(),
  status: z.enum(["queued", "published", "running", "done"]),
  lane: z
    .enum(["fast", "standard", "heavy", "xl", "unknown"])
    .optional()
    .default("unknown"),
  retry_after_ms: z.number().optional(),
});

export const pollResponseSchema = z.object({
  scrape_id: z.string(),
  status: z.enum([
    "queued",
    "published",
    "running",
    "done",
    "failed",
    "expired",
    "cancelled",
  ]),
  retry_after_ms: z.number().optional(),
  pages_processed: z.number().optional(),
  failed_pages: z.array(z.number()).nullable().optional(),
  partial_pages: z.array(z.number()).nullable().optional(),
  error_class: z.string().optional(),
  error_message: z.string().optional(),
});

/**
 * Physical page markdown payload, shared by the sync `/ocr` and async
 * `/jobs/:id/result` response schemas. When `include_blocks` is requested
 * without `include_page_markdown`, fire-pdf returns `pages` in a legacy
 * block-alias shape (`{page, width, height, status, blocks}` — no markdown).
 * The union matches that alias explicitly and drops it to `undefined`, so
 * genuine protocol corruption still fails the response parse, and the
 * callers' "requested page markdown missing" checks still fire when page
 * markdown was requested but absent.
 */
export const firePdfPagesSchema = z
  .union([
    z.array(
      z.object({ page: z.number().int().positive(), markdown: z.string() }),
    ),
    z
      .array(
        // Full documented alias shape (LegacyPageBlocks) — requiring every
        // field keeps the union discriminating: a payload that is neither
        // valid page markdown nor a complete alias fails the parse.
        z.object({
          page: z.number().int().positive(),
          width: z.number().nullable(),
          height: z.number().nullable(),
          status: z.string(),
          blocks: z.array(z.unknown()),
        }),
      )
      .transform((): undefined => undefined),
  ])
  .optional();

/** Typed layout blocks (fire-pdf docs/blocks-schema.md), present only when
 * the request set `include_blocks`. Wire shape — snake_case passthrough.
 * Single source of truth for the block contract: the response parsers and
 * the GCS cache validator both use it, and the wire TS types are inferred
 * from it. */
export const firePdfBlockPagesSchema = z.array(
  z.object({
    page: z.number().int().positive(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    // Documented values: ok | partial | failed. Kept open so a new
    // page status never fails an otherwise-valid scrape.
    status: z.string(),
    items: z.array(
      z.object({
        id: z.string(),
        type: z.string(),
        label: z.string().nullable(),
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .nullable(),
        content: z.string(),
        markdown_span: z.tuple([z.number(), z.number()]).nullable(),
        reading_order: z.number(),
        source: z.string().nullable(),
        confidence: z.object({
          layout: z.number().nullable(),
          ocr: z.number().nullable(),
        }),
      }),
    ),
  }),
);

export const firePdfBlocksSchema = firePdfBlockPagesSchema.optional();

export const resultResponseSchema = z.object({
  schema_version: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional(),
  markdown: z.string(),
  pages: firePdfPagesSchema,
  blocks: firePdfBlocksSchema,
  pages_processed: z.number().optional(),
  failed_pages: z.array(z.number()).nullable().optional(),
  partial_pages: z.array(z.number()).nullable().optional(),
  // Echo of an honored pageMarkers job option. Markers are baked into
  // `markdown` and their absence is not detectable by content, so the echo
  // is the only proof the fire-pdf worker build understood the option —
  // older workers ignore unknown option keys and omit it.
  page_markers: z.literal(true).optional(),
});

export type PollResponse = z.infer<typeof pollResponseSchema>;
export type ResultResponse = z.infer<typeof resultResponseSchema>;
