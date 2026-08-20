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
  help: "Count of requests that left fire-pdf async processing",
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
  | "http_401"
  | "http_404"
  | "http_410"
  | "http_413"
  | "http_502"
  | "http_503"
  | "http_429"
  | "http_5xx"
  | "network_error"
  | "deadline_too_close"
  | "terminal_failed"
  | "terminal_expired"
  | "terminal_cancelled"
  | "polling_timeout"
  | "result_503";

export const pdfCacheLookupCounter = new Counter({
  name: "firecrawl_pdf_cache_lookup_total",
  help: "FirePDF result cache lookups by outcome",
  labelNames: ["outcome"],
});

export const pdfCacheWriteCounter = new Counter({
  name: "firecrawl_pdf_cache_write_total",
  help: "FirePDF result cache write decisions by outcome",
  labelNames: ["outcome"],
});

export const pdfCacheServedAgeDays = new Histogram({
  name: "firecrawl_pdf_cache_served_age_days",
  help: "Age in days of FirePDF cache entries served to requests",
  buckets: [1, 3, 7, 14, 30, 60, 90, 180],
});
