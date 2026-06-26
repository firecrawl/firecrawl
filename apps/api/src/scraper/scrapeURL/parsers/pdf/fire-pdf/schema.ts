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
  schema_version: z.literal(1).optional(),
  markdown: z.string(),
  pages_processed: z.number().optional(),
  failed_pages: z.array(z.number()).nullable().optional(),
  partial_pages: z.array(z.number()).nullable().optional(),
});

export type PollResponse = z.infer<typeof pollResponseSchema>;
export type ResultResponse = z.infer<typeof resultResponseSchema>;
