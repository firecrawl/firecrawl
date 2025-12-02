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
  | "SCRAPE_ZDR_VIOLATION_ERROR"
  | "SCRAPE_DNS_RESOLUTION_ERROR"
  | "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR"
  | "SCRAPE_PDF_ANTIBOT_ERROR"
  | "SCRAPE_DOCUMENT_ANTIBOT_ERROR"
  | "SCRAPE_UNSUPPORTED_FILE_ERROR"
  | "SCRAPE_ACTION_ERROR"
  | "SCRAPE_RACED_REDIRECT_ERROR"
  | "SCRAPE_NO_CACHED_DATA"
  | "SCRAPE_SITEMAP_ERROR"
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
  constructor(message: string) {
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
    super(
      "UNKNOWN_ERROR",
      `(Internal server error) - ${inner && inner instanceof Error ? inner.message : inner}`,
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
    super("MAP_TIMEOUT", "Map timed out");
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
    super("SCRAPE_RACED_REDIRECT_ERROR", "Raced redirect error");
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
