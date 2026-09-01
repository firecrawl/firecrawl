export type ErrorCodes =
  | "THIRD_PARTY_DATA_TERMS_REQUIRED"
  | "SCRAPE_TIMEOUT"
  | "MAP_TIMEOUT"
  | "UNKNOWN_ERROR"
  | "SCRAPE_ALL_ENGINES_FAILED"
  | "SCRAPE_SSL_ERROR"
  | "SCRAPE_SITE_ERROR"
  | "SCRAPE_PROXY_SELECTION_ERROR"
  | "SCRAPE_PDF_PREFETCH_FAILED"
  | "SCRAPE_DOCUMENT_PREFETCH_FAILED"
  | "SCRAPE_JOB_CANCELLED"
  | "SCRAPE_RETRY_LIMIT"
  | "SCRAPE_ZDR_VIOLATION_ERROR"
  | "SCRAPE_DNS_RESOLUTION_ERROR"
  | "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR"
  | "SCRAPE_PDF_ANTIBOT_ERROR"
  | "SCRAPE_PDF_FETCH_PROXY_ERROR"
  | "SCRAPE_PDF_OCR_REQUIRED"
  | "SCRAPE_DOCUMENT_ANTIBOT_ERROR"
  | "SCRAPE_DOCUMENT_FETCH_PROXY_ERROR"
  | "SCRAPE_UNSUPPORTED_FILE_ERROR"
  | "SCRAPE_ACTION_ERROR"
  | "SCRAPE_RACED_REDIRECT_ERROR"
  | "SCRAPE_NO_CACHED_DATA"
  | "SCRAPE_LOCKDOWN_CACHE_MISS"
  | "SCRAPE_SITEMAP_ERROR"
  | "SCRAPE_ACTIONS_NOT_SUPPORTED"
  | "SCRAPE_BRANDING_NOT_SUPPORTED"
  | "AGENT_INDEX_ONLY"
  | "SCRAPE_AUDIO_UNSUPPORTED_URL"
  | "SCRAPE_VIDEO_UNSUPPORTED_URL"
  | "SCRAPE_MEDIA_ACCESS_DENIED"
  | "SCRAPE_PROMPT_INJECTION_DETECTED"
  | "SCRAPE_JSON_CONTENT_TOO_LARGE"
  | "SCRAPE_X_TWITTER_CONFIGURATION_ERROR"
  | "PARSE_UNSUPPORTED_OPTIONS"
  | "CRAWL_DENIAL"
  | "MAP_FAILED"
  | "BAD_REQUEST_INVALID_JSON"
  | "BAD_REQUEST"
  | "CONCURRENCY_QUEUE_TIMEOUT"
  // Threat protection (enterprise domain risk blocking). Lowercase by design:
  // this is the documented, user-facing error code for the feature.
  | "unsafe_domain_blocked"
  // Agent threads. Lowercase for the same reason as unsafe_domain_blocked.
  | "thread_not_found"
  | "thread_busy"
  | "thread_expired"
  | "threads_disabled"
  | "exchange_not_enabled";

export class TransportableError extends Error {
  public readonly code: ErrorCodes;

  constructor(code: ErrorCodes, message?: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }

  serialize() {
    return {
      cause: this.cause,
      stack: this.stack,
      message: this.message,
    };
  }

  static deserialize(
    code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new TransportableError(code, data.message, { cause: data.cause });
    x.stack = data.stack;
    return x;
  }
}

/**
 * Attached to a SCRAPE_TIMEOUT when a large-PDF (by-reference FirePDF)
 * job keeps processing server-side after the request's own window
 * expired — by design, the job is not cancelled (see fire-pdf/async.ts).
 * Surfaced to the caller as the error response's `details` plus a
 * `Retry-After` header, so a retry of the same URL is a deliberate,
 * timed action instead of a blind loop.
 */
type ScrapeTimeoutProcessingDetails = {
  state: "processing_continues";
  documentPages?: number;
  jobStatus: "queued" | "running";
  estimatedRemainingSeconds: number;
  retryAfterSeconds: number;
  /** Set when the document may not finish within the server-side
   * processing ceiling even across retries. */
  mayExceedProcessingWindow?: boolean;
};

/** Matches BY_REFERENCE_DEADLINE_PER_PAGE_MS (fire-pdf/utils.ts) — the
 * conservative worst-case processing rate the job deadline is built
 * from (covers fully scanned documents, not the text-extraction
 * median). Kept as a default parameter here so lib/error stays free of
 * scraper imports; keep the two constants in lockstep or the retry
 * hints understate what the deadline actually allows. */
const PROCESSING_ESTIMATE_PER_PAGE_MS = 1_250;
/** Fixed overhead the estimate grants beyond pure page work: queue
 * pickup, render bootstrap, result assembly. */
const PROCESSING_ESTIMATE_BASE_MS = 60_000;

/**
 * Compose the customer-facing "we're still working on it" message and
 * structured details for a timed-out large-PDF scrape. Estimates are
 * deliberately conservative and coarse (whole minutes, floored at one):
 * an estimate that is early twice reads as magic, one that is late once
 * reads as broken.
 */
export function composeTimeoutProcessing(args: {
  pagesEstimate?: number;
  submittedAtMs: number;
  jobDeadlineAtMs?: number;
  lastStatus: "queued" | "published" | "running";
  nowMs: number;
  perPageMs?: number;
  /** fire-pdf's live estimate from the last poll that carried one, and
   * when it was observed. Preferred over the static per-page math: the
   * server sees measured lane throughput and real queue depth, which
   * the static formula cannot. */
  serverEstimate?: { remainingMs: number; observedAtMs: number };
}): { message: string; details: ScrapeTimeoutProcessingDetails } {
  const perPageMs = args.perPageMs ?? PROCESSING_ESTIMATE_PER_PAGE_MS;
  const pages = args.pagesEstimate;
  const totalMs =
    pages !== undefined && pages > 0
      ? pages * perPageMs + PROCESSING_ESTIMATE_BASE_MS
      : 5 * 60_000;
  const elapsedMs = Math.max(0, args.nowMs - args.submittedAtMs);
  // Live server estimate wins when available, aged by the time since we
  // observed it; the static formula is the fallback for older fire-pdf
  // builds and lanes without measured throughput.
  const serverRemainingMs =
    args.serverEstimate !== undefined
      ? args.serverEstimate.remainingMs -
        Math.max(0, args.nowMs - args.serverEstimate.observedAtMs)
      : undefined;
  const remainingMs =
    serverRemainingMs !== undefined
      ? Math.max(60_000, serverRemainingMs)
      : Math.max(60_000, totalMs - elapsedMs);
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  const estimatedRemainingSeconds = remainingMinutes * 60;
  const retryAfterSeconds = Math.min(600, estimatedRemainingSeconds);
  const jobStatus: "queued" | "running" =
    args.lastStatus === "running" ? "running" : "queued";
  const mayExceedProcessingWindow =
    args.jobDeadlineAtMs !== undefined &&
    args.nowMs + remainingMs > args.jobDeadlineAtMs;

  const docLabel =
    pages !== undefined && pages > 0 ? `this ${pages}-page PDF` : "this PDF";
  const inMinutes = `~${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;

  const message = mayExceedProcessingWindow
    ? `Request timed out. Note: ${docLabel} is very large and may exceed the maximum server-side processing window. Retry the same URL in ${inMinutes} to pick up the result if it completes; if retries keep timing out, pass a larger \`timeout\` or contact support to raise your document processing ceiling.`
    : jobStatus === "running"
      ? `Request timed out, but ${docLabel} is still being processed on our side. Retrying the same URL in ${inMinutes} returns the completed result without re-processing. To avoid the retry entirely, pass a \`timeout\` that covers the estimate.`
      : `Request timed out. Note: ${docLabel} is queued for processing on our side and will not lose its place. Retrying the same URL in ${inMinutes} returns the completed result without re-processing.`;

  return {
    message,
    details: {
      state: "processing_continues",
      ...(pages !== undefined && pages > 0 && { documentPages: pages }),
      jobStatus,
      estimatedRemainingSeconds,
      retryAfterSeconds,
      ...(mayExceedProcessingWindow && { mayExceedProcessingWindow: true }),
    },
  };
}

/** Safe accessor for the processing details on a (possibly deserialized)
 * SCRAPE_TIMEOUT error. */
export function getTimeoutProcessingDetails(
  e: unknown,
): ScrapeTimeoutProcessingDetails | undefined {
  if (e instanceof TransportableError && e.code === "SCRAPE_TIMEOUT") {
    const p = (e as ScrapeJobTimeoutError).processing;
    if (p && p.state === "processing_continues") return p;
  }
  return undefined;
}

export class ScrapeJobTimeoutError extends TransportableError {
  constructor(
    message: string = "The scrape operation timed out before completing. This happens when a page takes too long to load, render, or process. Possible causes: (1) The website is slow or unresponsive, (2) The page has heavy JavaScript that takes time to execute, (3) The page is very large or has many resources to load, (4) Network latency is high. To fix this, try increasing the timeout parameter in your scrape request, or if using actions, ensure your selectors are correct and the page is ready before actions are executed.",
    public processing?: ScrapeTimeoutProcessingDetails,
  ) {
    super("SCRAPE_TIMEOUT", message);
  }

  serialize() {
    return {
      ...super.serialize(),
      processing: this.processing,
    };
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ScrapeJobTimeoutError(data.message, data.processing);
    x.stack = data.stack;
    return x;
  }
}

export class ConcurrencyQueueTimeoutError extends TransportableError {
  constructor(
    message: string = "The operation timed out while waiting for a concurrency slot to become available. This means that your requests are exhausting your concurrent browsers limit. Consider using batch endpoints which wait for concurrency slots to become available indefinitely, or consider upgrading your plan to incrase your concurrency limit at https://firecrawl.dev/pricing.",
  ) {
    super("CONCURRENCY_QUEUE_TIMEOUT", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ConcurrencyQueueTimeoutError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class UnknownError extends TransportableError {
  constructor(inner: unknown) {
    const innerMessage =
      inner && inner instanceof Error ? inner.message : String(inner);
    super(
      "UNKNOWN_ERROR",
      `An unexpected internal error occurred while processing your request. Error details: "${innerMessage}". This is typically a temporary issue. Please try your request again. If the problem persists, contact support with your request ID and this error message for investigation.`,
    );

    if (inner instanceof Error) {
      this.stack = inner.stack;
    }
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnknownError("dummy");
    x.message = data.message;
    x.stack = data.stack;
    return x;
  }
}

export class MapTimeoutError extends TransportableError {
  constructor() {
    super(
      "MAP_TIMEOUT",
      "The map operation timed out before completing. This happens when discovering URLs on a large website takes too long. Try using a more specific starting URL, or increase the timeout parameter if available.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new MapTimeoutError();
    x.stack = data.stack;
    return x;
  }
}

export class MapFailedError extends TransportableError {
  constructor(message: string) {
    super("MAP_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new MapFailedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class RacedRedirectError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_RACED_REDIRECT_ERROR",
      "This URL was not scraped because another scrape job in this same crawl or batch scrape has already scraped this URL (usually due to a redirect). This is an expected error used to prevent duplicate scrapes of the same URL and ensure efficiency. No action is needed - the content is already captured by the other scrape job.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new RacedRedirectError();
    x.stack = data.stack;
    return x;
  }
}

export class SitemapError extends TransportableError {
  constructor(message: string, cause?: unknown) {
    super("SCRAPE_SITEMAP_ERROR", message, { cause });
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SitemapError(data.message, data.cause);
    x.stack = data.stack;
    return x;
  }
}

export class CrawlDenialError extends TransportableError {
  constructor(public reason: string) {
    super("CRAWL_DENIAL", reason);
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize> & { reason: string },
  ) {
    const x = new CrawlDenialError(data.reason);
    x.stack = data.stack;
    return x;
  }
}

export class ActionsNotSupportedError extends TransportableError {
  constructor(message: string) {
    super("SCRAPE_ACTIONS_NOT_SUPPORTED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ActionsNotSupportedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

/**
 * Error thrown when a job is cancelled (expected flow control, not a real error)
 * This should not be sent to Sentry as it's expected behavior when a crawl/batch is cancelled
 */
export class JobCancelledError extends Error {
  constructor() {
    super(
      "This scrape was not completed because the parent crawl or batch scrape was cancelled. This happens when you call the cancel endpoint on a crawl or batch scrape, or when the operation is stopped for another reason. Any URLs that were already scraped before cancellation are still available in the results.",
    );
    this.name = "JobCancelledError";
  }
}
