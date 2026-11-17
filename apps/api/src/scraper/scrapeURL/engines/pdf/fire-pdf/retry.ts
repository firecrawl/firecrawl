import { FirePdfAsyncFailure } from "./utils";
import type { FallbackReason } from "./metrics";
import { FirePdfScrapeIdConflictError } from "./submit";

/** Below this much remaining scrape time a second FirePDF attempt can't
 * finish, so the request goes straight to the next fallback. */
export const FIRE_PDF_RETRY_MIN_REMAINING_MS = 15_000;

const RETRYABLE_ASYNC_REASONS = new Set<FallbackReason>([
  "http_429",
  "http_502",
  "http_503",
  "result_503",
  "network_error",
  "deadline_too_close",
  "polling_timeout",
  "terminal_expired",
]);

// fire-pdf job error classes that describe the infrastructure rather than
// the document: a second attempt can succeed where the first did not.
const RETRYABLE_JOB_ERROR_CLASS =
  /^(all_pages_failed|ocr_unavailable|gcs_upload_failed|gcs_fetch_transport|deadline_exceeded.*)$/;

function jobErrorClass(error: FirePdfAsyncFailure): unknown {
  const body = error.extra.body as { error_class?: unknown } | undefined;
  return error.extra.errorClass ?? body?.error_class;
}

/** Whether a FirePDF failure is transient: a timeout, an overloaded or
 * unavailable service, a network error, or an async job that failed for
 * infrastructure reasons. A conflict on the async job id is included because
 * the synchronous endpoint has no job identity to conflict with. */
export function isTransientFirePdfFailure(error: unknown): boolean {
  if (error instanceof FirePdfScrapeIdConflictError) return true;
  if (error instanceof FirePdfAsyncFailure) {
    if (RETRYABLE_ASYNC_REASONS.has(error.reason)) return true;
    // http_5xx also covers unexpected 4xx and response-validation failures;
    // only a real 5xx status is an infrastructure error.
    if (error.reason === "http_5xx") {
      const status = error.extra.status;
      return typeof status === "number" && status >= 500;
    }
    if (error.reason !== "terminal_failed") return false;
    const errorClass = jobErrorClass(error);
    return (
      typeof errorClass === "string" &&
      RETRYABLE_JOB_ERROR_CLASS.test(errorClass)
    );
  }
  if (!(error instanceof Error)) return false;
  if (error.message === "Request failed") return true;
  const status = (
    error.cause as { response?: { status?: unknown } } | undefined
  )?.response?.status;
  return typeof status === "number" && (status === 429 || status >= 500);
}

export function shouldRetryFirePdf(
  error: unknown,
  remainingMs: number | undefined,
): boolean {
  return (
    isTransientFirePdfFailure(error) &&
    (remainingMs === undefined ||
      remainingMs >= FIRE_PDF_RETRY_MIN_REMAINING_MS)
  );
}
