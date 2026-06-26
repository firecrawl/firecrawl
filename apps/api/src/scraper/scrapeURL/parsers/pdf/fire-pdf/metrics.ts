import { Counter, Histogram } from "prom-client";

export const firePdfAsyncSubmittedTotal = new Counter({
  name: "firecrawl_fire_pdf_async_submitted_total",
  help: "Count of POST /jobs requests successfully submitted to fire-pdf async",
  labelNames: ["lane"],
});

export const firePdfAsyncCompletedTotal = new Counter({
  name: "firecrawl_fire_pdf_async_completed_total",
  help: "Count of fire-pdf async jobs that reached a terminal status",
  labelNames: ["terminal_status"],
});

export const firePdfAsyncFallbackTotal = new Counter({
  name: "firecrawl_fire_pdf_async_fallback_total",
  help: "Count of fire-pdf async requests that fell back to the sync /ocr path",
  labelNames: ["reason"],
});

export const firePdfAsyncTotalDurationSeconds = new Histogram({
  name: "firecrawl_fire_pdf_async_total_duration_seconds",
  help: "End-to-end duration from 'decide to use async' to 'result available'",
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800],
});

export const firePdfAsyncPollCount = new Histogram({
  name: "firecrawl_fire_pdf_async_poll_count",
  help: "Number of GET /jobs/:id polls performed per fire-pdf async job",
  buckets: [1, 2, 5, 10, 20, 50, 100, 200, 500],
});

export type FallbackReason =
  | "http_404"
  | "http_413"
  | "http_503"
  | "http_429"
  | "http_5xx"
  | "network_error"
  | "terminal_failed"
  | "terminal_expired"
  | "terminal_cancelled"
  | "polling_timeout"
  | "result_503";
