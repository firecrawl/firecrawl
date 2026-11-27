import { z } from "zod";
import { inMemoryJsonValueSchema, jsonRecordSchema } from "./json-types";
import type { JsonObject, LogMeta } from "./json-types";
import { UNSUPPORTED_SITE_MESSAGE } from "./strings";

/**
 * Every error code, as the keys of an interface so that a package built on
 * this one can add its own by declaration merging.
 */
export interface ErrorCodes {
  THIRD_PARTY_DATA_TERMS_REQUIRED: true;
  THIRD_PARTY_DATA_NOT_FOUND: true;
  THIRD_PARTY_DATA_UNSUPPORTED_URL: true;
  THIRD_PARTY_DATA_UNSUPPORTED_OPTION: true;
  THIRD_PARTY_DATA_NOT_ENABLED: true;
  THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED: true;
  SCRAPE_TIMEOUT: true;
  MAP_TIMEOUT: true;
  UNKNOWN_ERROR: true;
  SCRAPE_ALL_ENGINES_FAILED: true;
  SCRAPE_SSL_ERROR: true;
  SCRAPE_SITE_ERROR: true;
  SCRAPE_PROXY_SELECTION_ERROR: true;
  SCRAPE_PDF_PREFETCH_FAILED: true;
  SCRAPE_DOCUMENT_PREFETCH_FAILED: true;
  SCRAPE_JOB_CANCELLED: true;
  SCRAPE_RETRY_LIMIT: true;
  SCRAPE_ZDR_VIOLATION_ERROR: true;
  SCRAPE_DNS_RESOLUTION_ERROR: true;
  SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: true;
  SCRAPE_PDF_ANTIBOT_ERROR: true;
  SCRAPE_PDF_FETCH_PROXY_ERROR: true;
  SCRAPE_PDF_OCR_REQUIRED: true;
  SCRAPE_DOCUMENT_ANTIBOT_ERROR: true;
  SCRAPE_DOCUMENT_FETCH_PROXY_ERROR: true;
  SCRAPE_UNSUPPORTED_FILE_ERROR: true;
  SCRAPE_ACTION_ERROR: true;
  SCRAPE_RACED_REDIRECT_ERROR: true;
  SCRAPE_NO_CACHED_DATA: true;
  SCRAPE_LOCKDOWN_CACHE_MISS: true;
  SCRAPE_SITEMAP_ERROR: true;
  SCRAPE_ACTIONS_NOT_SUPPORTED: true;
  AGENT_INDEX_ONLY: true;
  INDEX_DAILY_LIMIT: true;
  TOOL_DISCOVERY_UNAVAILABLE: true;
  SCRAPE_PROMPT_INJECTION_DETECTED: true;
  SCRAPE_PAYWALLED_CONTENT: true;
  SCRAPE_JSON_CONTENT_TOO_LARGE: true;
  US_ONLY_UNAVAILABLE: true;
  RESERVED_CAPACITY_UNAVAILABLE: true;
  PARSE_UNSUPPORTED_OPTIONS: true;
  UNSUPPORTED_FILE_TYPE: true;
  CRAWL_DENIAL: true;
  UNSUPPORTED_SITE: true;
  MAP_FAILED: true;
  BAD_REQUEST_INVALID_JSON: true;
  BAD_REQUEST: true;
  CATEGORY_REMOVED: true;
  CONCURRENCY_QUEUE_TIMEOUT: true;
  SAFE_MODE_BLOCKED: true;
  SCRAPE_SITE_RESTRICTION_BLOCKED: true;
  // Threat protection (enterprise domain risk blocking). Lowercase by design:
  // this is the documented, user-facing error code for the feature.
  unsafe_domain_blocked: true;
  // Agent threads. Lowercase for the same reason as unsafe_domain_blocked.
  thread_not_found: true;
  thread_busy: true;
  thread_expired: true;
  threads_disabled: true;
  exchange_not_enabled: true;
  // GET /v2/agent/:jobId. The job id is unknown, or the status service
  // could not be read and the caller should retry.
  agent_not_found: true;
  agent_status_unavailable: true;
  // Agent zero data retention. Lowercase to match the agent service's codes.
  zdr_threads_unsupported: true;
  zdr_expired: true;
  zdr_no_snapshots: true;
  zdr_not_enabled: true;
  zdr_retention_misconfigured: true;
}

export type ErrorCode = keyof ErrorCodes;

// Symbol.for gives every copy of this module in a process the same symbol.
const transportableErrorBrand = Symbol.for("firecrawl.TransportableError");

export class TransportableError extends Error {
  public readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }

  get [transportableErrorBrand](): true {
    return true;
  }

  /** Whether throwing this error inside a scrape engine ends the engine loop and rethrows as-is. */
  get endsEngineLoop(): boolean {
    return false;
  }

  /** Whether this error aborts racing engines immediately and fails as NoEnginesLeftError. */
  get abortsEngineRace(): boolean {
    return false;
  }

  /** Whether a crawl-level scrape retry loop should stop instead of retrying this error. */
  get stopsCrawlRetry(): boolean {
    return false;
  }

  /** Whether JSON extraction should rethrow this error rather than turning it into a warning. */
  get propagateFromExtraction(): boolean {
    return false;
  }

  /** HTTP status code for API controllers when this error is returned to the caller. */
  get httpStatus(): number | undefined {
    return undefined;
  }

  /** Optional extra top-level fields merged into HTTP JSON error responses. */
  get httpResponseFields(): JsonObject | undefined {
    return undefined;
  }

  /** Optional scrapeURL warning log message, telemetry errorType, and structured context. */
  get scrapeLog(): ErrorScrapeLog | undefined {
    return undefined;
  }

  serialize() {
    return {
      cause: this.cause,
      stack: this.stack,
      message: this.message,
    };
  }

  static deserialize(
    code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new TransportableError(code, data.message, { cause: data.cause });
    x.stack = data.stack;
    return x;
  }
}

/**
 * Whether a value is a transportable error: an error that carries the brand,
 * has a code and can write itself. Unlike `instanceof`, this also holds for
 * an error built by another copy of this module, so ask it wherever the
 * question is whether an error can cross the job queue with its code.
 */
export function isTransportableError(
  error: unknown,
): error is TransportableError {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    transportableErrorBrand in error &&
    error[transportableErrorBrand] === true &&
    "code" in error &&
    typeof error.code === "string" &&
    "serialize" in error &&
    typeof error.serialize === "function"
  );
}

/**
 * Base class for errors thrown when a requested scrape format cannot be served
 * for a page. Concrete subclasses must register their own deserializer so the
 * error retains its `format` and `warning` across the job queue; the scrape
 * loop drops the format, keeps the remaining formats, and adds `warning` to the
 * document while requests for only that format fail with this error.
 */
export abstract class FormatUnavailableError extends TransportableError {
  public readonly format: string;
  public readonly warning: string;

  protected constructor(
    format: string,
    code: ErrorCode,
    message: string,
    warning: string = message,
  ) {
    super(code, message);
    this.format = format;
    this.warning = warning;
  }
}

/**
 * Structural check for a FormatUnavailableError, working across separate
 * copies of this module.
 */
export function isFormatUnavailable(
  error: unknown,
): error is FormatUnavailableError {
  if (!isTransportableError(error)) {
    return false;
  }
  if (!("format" in error) || !("warning" in error)) {
    return false;
  }
  return (
    typeof error.format === "string" &&
    error.format.length > 0 &&
    typeof error.warning === "string"
  );
}

/** Structural check for errors that end the scrape engine waterfall loop as-is. */
export function endsEngineLoop(error: unknown): boolean {
  return (
    error instanceof Error &&
    "endsEngineLoop" in error &&
    error.endsEngineLoop === true
  );
}

/** Structural check for errors that abort racing engines and fail as NoEnginesLeftError. */
export function abortsEngineRace(error: unknown): boolean {
  return (
    error instanceof Error &&
    "abortsEngineRace" in error &&
    error.abortsEngineRace === true
  );
}

/** Structural check for errors that stop the crawl-level scrape retry loop. */
export function stopsCrawlRetry(error: unknown): boolean {
  return (
    error instanceof Error &&
    "stopsCrawlRetry" in error &&
    error.stopsCrawlRetry === true
  );
}

/** Structural check for errors that JSON extraction must rethrow instead of warning. */
export function shouldPropagateFromExtraction(error: unknown): boolean {
  return (
    error instanceof Error &&
    "propagateFromExtraction" in error &&
    error.propagateFromExtraction === true
  );
}

interface ErrorHttpResponse {
  status: number;
  code?: ErrorCode;
  message: string;
  extraFields?: JsonObject;
}

const errorHttpMetaSchema = z.object({
  httpStatus: z.number().int().min(100).max(599),
});

// ErrorCodes is open via declaration merging, so extension errors may carry
// codes outside core's ErrorCodes interface.
const errorCodeSchema = z.custom<ErrorCode>(
  value => typeof value === "string" && value.length > 0,
);

const logMetaSchema = z.record(
  z.string(),
  z.union([inMemoryJsonValueSchema, z.instanceof(Error), z.instanceof(Date)]),
);

const rawScrapeLogSchema = z.object({
  errorType: z.string().min(1),
  message: z.string().min(1),
  context: z.unknown().optional(),
});

/**
 * Reads HTTP response metadata from any Error declaring an integer `httpStatus`.
 */
export function getErrorHttpResponse(
  error: unknown,
): ErrorHttpResponse | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const meta = errorHttpMetaSchema.safeParse(error);
  if (!meta.success) {
    return undefined;
  }
  const response: ErrorHttpResponse = {
    status: meta.data.httpStatus,
    message: error.message,
  };
  if ("code" in error) {
    const parsedCode = errorCodeSchema.safeParse(error.code);
    if (parsedCode.success) {
      response.code = parsedCode.data;
    }
  }
  if ("httpResponseFields" in error) {
    const parsedFields = jsonRecordSchema.safeParse(error.httpResponseFields);
    if (parsedFields.success) {
      response.extraFields = parsedFields.data;
    }
  }
  return response;
}

export interface ErrorScrapeLog {
  errorType: string;
  message: string;
  context?: LogMeta;
}

/**
 * Reads custom scrapeURL warning log metadata from an error, when declared.
 */
export function getErrorScrapeLog(error: unknown): ErrorScrapeLog | undefined {
  if (!(error instanceof Error) || !("scrapeLog" in error)) {
    return undefined;
  }
  const parsed = rawScrapeLogSchema.safeParse(error.scrapeLog);
  if (!parsed.success) {
    return undefined;
  }
  const log: ErrorScrapeLog = {
    errorType: parsed.data.errorType,
    message: parsed.data.message,
  };
  const parsedContext = logMetaSchema.safeParse(parsed.data.context);
  if (parsedContext.success) {
    log.context = parsedContext.data;
  }
  return log;
}

/** A class of transportable error, registered under the codes it carries. */
export interface TransportableErrorClass {
  readonly codes: ReadonlyArray<ErrorCode>;
  /** Rebuilds an error from the parsed payload its `serialize()` wrote. */
  deserialize(code: ErrorCode, data: unknown): TransportableError;
}

/**
 * Attached to a SCRAPE_TIMEOUT when a large-PDF (by-reference FirePDF)
 * job keeps processing server-side after the request's own window
 * expired — by design, the job is not cancelled (see fire-pdf/async.ts).
 * Surfaced to the caller as the error response's `details` plus a
 * `Retry-After` header, so a retry of the same URL is a deliberate,
 * timed action instead of a blind loop.
 */
const scrapeTimeoutProcessingDetailsSchema = z.object({
  state: z.literal("processing_continues"),
  documentPages: z
    .number()
    .nullable()
    .transform(value => value ?? undefined)
    .optional(),
  jobStatus: z.enum(["queued", "running"]),
  estimatedRemainingSeconds: z.number(),
  retryAfterSeconds: z.number(),
  mayExceedProcessingWindow: z
    .boolean()
    .nullable()
    .transform(value => value ?? undefined)
    .optional(),
});

type ScrapeTimeoutProcessingDetails = z.infer<
  typeof scrapeTimeoutProcessingDetailsSchema
>;

/** Matches BY_REFERENCE_DEADLINE_PER_PAGE_MS (fire-pdf/utils.ts) — the
 * conservative worst-case processing rate the job deadline is built
 * from (covers fully scanned documents, not the text-extraction
 * median). Kept as a default parameter here so lib/error stays free of
 * scraper imports; keep the two constants in lockstep or the retry
 * hints understate what the deadline actually allows. */
const PROCESSING_ESTIMATE_PER_PAGE_MS = 1250;
/** Fixed overhead the estimate grants beyond pure page work: queue
 * pickup, render bootstrap, result assembly. */
const PROCESSING_ESTIMATE_BASE_MS = 60_000;

interface TimeoutProcessingOutcome {
  message: string;
  details: ScrapeTimeoutProcessingDetails;
}

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
}): TimeoutProcessingOutcome {
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
  if (
    isTransportableError(e) &&
    e.code === "SCRAPE_TIMEOUT" &&
    "processing" in e
  ) {
    const parsed = scrapeTimeoutProcessingDetailsSchema.safeParse(e.processing);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export class ScrapeJobTimeoutError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["SCRAPE_TIMEOUT"];

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
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ScrapeJobTimeoutError(data.message, data.processing);
    x.stack = data.stack;
    return x;
  }
}

export class ConcurrencyQueueTimeoutError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = [
    "CONCURRENCY_QUEUE_TIMEOUT",
  ];

  constructor(
    message: string = "The operation timed out while waiting for a concurrency slot to become available. This means that your requests are exhausting your concurrent browsers limit. Consider using batch endpoints which wait for concurrency slots to become available indefinitely, or consider upgrading your plan to incrase your concurrency limit at https://firecrawl.dev/pricing.",
  ) {
    super("CONCURRENCY_QUEUE_TIMEOUT", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ConcurrencyQueueTimeoutError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class UnknownError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["UNKNOWN_ERROR"];

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
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnknownError("dummy");
    x.message = data.message;
    x.stack = data.stack;
    return x;
  }
}

export class MapTimeoutError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["MAP_TIMEOUT"];

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
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new MapTimeoutError();
    x.stack = data.stack;
    return x;
  }
}

export class MapFailedError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["MAP_FAILED"];

  constructor(message: string) {
    super("MAP_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new MapFailedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class RacedRedirectError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = [
    "SCRAPE_RACED_REDIRECT_ERROR",
  ];

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
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new RacedRedirectError();
    x.stack = data.stack;
    return x;
  }
}

export class SitemapError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["SCRAPE_SITEMAP_ERROR"];

  constructor(message: string, cause?: unknown) {
    super("SCRAPE_SITEMAP_ERROR", message, { cause });
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SitemapError(data.message, data.cause);
    x.stack = data.stack;
    return x;
  }
}

export class CrawlDenialError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["CRAWL_DENIAL"];

  /** The URL robots.txt disallows, or null when robots.txt did not cause the denial. */
  public robotsBlockedUrl: string | null;

  constructor(
    public reason: string,
    options: { robotsBlockedUrl?: string | null } = {},
  ) {
    super("CRAWL_DENIAL", reason);
    this.robotsBlockedUrl = options.robotsBlockedUrl ?? null;
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
      robotsBlockedUrl: this.robotsBlockedUrl,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize> & { reason: string },
  ) {
    const x = new CrawlDenialError(data.reason, {
      robotsBlockedUrl: data.robotsBlockedUrl,
    });
    x.stack = data.stack;
    return x;
  }
}

export class UnsupportedSiteError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = ["UNSUPPORTED_SITE"];

  constructor() {
    super("UNSUPPORTED_SITE", UNSUPPORTED_SITE_MESSAGE);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnsupportedSiteError();
    x.stack = data.stack;
    return x;
  }
}

export class ActionsNotSupportedError extends TransportableError {
  static readonly codes: ReadonlyArray<ErrorCode> = [
    "SCRAPE_ACTIONS_NOT_SUPPORTED",
  ];

  constructor(message: string) {
    super("SCRAPE_ACTIONS_NOT_SUPPORTED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ActionsNotSupportedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

/**
 * Error thrown when a job is cancelled (expected flow control, not a real error)
 * This is expected behavior when a crawl/batch is cancelled
 */
export class JobCancelledError extends Error {
  constructor() {
    super(
      "This scrape was not completed because the parent crawl or batch scrape was cancelled. This happens when you call the cancel endpoint on a crawl or batch scrape, or when the operation is stopped for another reason. Any URLs that were already scraped before cancellation are still available in the results.",
    );
    this.name = "JobCancelledError";
  }
}
