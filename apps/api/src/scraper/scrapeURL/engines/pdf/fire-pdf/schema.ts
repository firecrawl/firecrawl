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

// An inline job's deadline sits this far inside the caller's window. The
// caller aborts the scrape the instant its window closes, so a job that is
// still wrapping up at that instant is cancelled and every processed page is
// lost. The margin covers the worker's end-of-deadline work (degrade the
// remaining pages, assemble, upload) plus one poll interval and the result
// fetch, so the deadline-degraded result the worker produces anyway is the
// one the caller receives: 10% of the window, floored at 10s (a backoff-capped
// poll alone is ~6s with jitter) and capped at 30s.
export const INLINE_JOB_DEADLINE_MARGIN_FRACTION = 0.1;
export const INLINE_JOB_DEADLINE_MARGIN_MIN_MS = 10_000;
export const INLINE_JOB_DEADLINE_MARGIN_MAX_MS = 30_000;
// Polls are pulled forward so one lands this long after the job deadline,
// then run at POLL_FLOOR_MS until the caller window closes: the job is
// expected to finish right there, and a backoff-capped poll would miss it.
export const JOB_DEADLINE_POLL_GRACE_MS = 1_000;
// One retry on a submit that provably never reached fire-pdf's handler: a
// transport failure, or a 503 carrying Fastify's canned shutdown body
// instead of one of fire-pdf's own 503 codes. Rolling api pods leave
// kept-alive connections pointed at terminating pods; the retry opens a
// fresh connection to a live one. POST /jobs is idempotent on scrape_id, so
// a first request that did land is replayed, never duplicated.
export const SUBMIT_TRANSIENT_RETRY_DELAY_MS = 250;
// Slack for the submit round trip: fire-pdf validates `deadline_at - now`
// against MIN_DEADLINE_MS on arrival, so the advertised deadline must clear
// it by at least the request's flight time.
export const INLINE_SUBMIT_SLACK_MS = 5_000;
// The smallest caller window async accepts. Below it, the margin would push
// the inline job deadline to (or under) fire-pdf's minimum and the submit
// would be rejected on arrival; such requests take the sync path instead.
export const MIN_ASYNC_CALLER_WINDOW_MS =
  MIN_DEADLINE_MS + INLINE_JOB_DEADLINE_MARGIN_MIN_MS + INLINE_SUBMIT_SLACK_MS;

export const TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "expired",
  "cancelled",
]);

/** Error body fire-pdf's own handlers send with a non-2xx status: a
 * snake_case code (`admission_rejected`, `gcs_upload_failed`, ...) plus a
 * human message. Anything else on a 503 did not come from a handler. */
export const firePdfErrorBodySchema = z
  .object({
    error: z.string().regex(/^[a-z][a-z0-9_]*$/),
    message: z.string().optional(),
  })
  .passthrough();

/** Fastify's canned reply while an instance is shutting down
 * (`return503OnClosing`, sent with `Connection: close` before any route
 * handler runs): the request was never processed. */
export const fastifyClosingBodySchema = z
  .object({
    error: z.literal("Service Unavailable"),
    statusCode: z.literal(503),
  })
  .passthrough();

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
  // Live remaining-time estimate computed server-side from lane
  // throughput + backlog (fire-pdf phase 2). Optional and additive;
  // absent on older fire-pdf builds or when the lane has no measured
  // throughput. `.catch(undefined)` so a malformed value (negative,
  // NaN, Infinity) degrades to "no estimate" instead of failing the
  // whole poll response.
  estimated_remaining_ms: z
    .number()
    .finite()
    .nonnegative()
    .optional()
    .catch(undefined),
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
