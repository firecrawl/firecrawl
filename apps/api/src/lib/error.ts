export type ErrorCodes =
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
  | "SCRAPE_PDF_OCR_REQUIRED"
  | "SCRAPE_DOCUMENT_ANTIBOT_ERROR"
  | "SCRAPE_UNSUPPORTED_FILE_ERROR"
  | "SCRAPE_ACTION_ERROR"
  | "SCRAPE_RACED_REDIRECT_ERROR"
  | "SCRAPE_NO_CACHED_DATA"
  | "SCRAPE_SITEMAP_ERROR"
  | "SCRAPE_ACTIONS_NOT_SUPPORTED"
  | "SCRAPE_BRANDING_NOT_SUPPORTED"
  | "CRAWL_DENIAL"
  | "BAD_REQUEST_INVALID_JSON"
  | "BAD_REQUEST";

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

export class ScrapeJobTimeoutError extends TransportableError {
  constructor(
    message: string = "The scrape operation timed out before completing. This happens when a page takes too long to load, render, or process. Possible causes: (1) The website is slow or unresponsive, (2) The page has heavy JavaScript that takes time to execute, (3) The page is very large or has many resources to load, (4) Network latency is high. To fix this, try increasing the timeout parameter in your scrape request, or if using actions, ensure your selectors are correct and the page is ready before actions are executed.",
  ) {
    super("SCRAPE_TIMEOUT", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ScrapeJobTimeoutError(data.message);
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
