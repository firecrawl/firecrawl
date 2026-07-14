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
  lane: z.string().optional(),
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

export const resultResponseSchema = z.object({
  // v1 results carry schema_version 1 (or omit it); jobs submitted with
  // include_blocks return schema_version 2 + `pages`. Non-strict so either
  // generation of fire-pdf parses.
  schema_version: z.union([z.literal(1), z.literal(2)]).optional(),
  markdown: z.string(),
  pages_processed: z.number().optional(),
  failed_pages: z.array(z.number()).nullable().optional(),
  partial_pages: z.array(z.number()).nullable().optional(),
  // Per-page typed blocks (fire-pdf docs/blocks-schema.md). Loose on
  // purpose — forward-compatible passthrough.
  pages: z.array(z.looseObject({})).optional(),
});

export type PollResponse = z.infer<typeof pollResponseSchema>;
export type ResultResponse = z.infer<typeof resultResponseSchema>;
