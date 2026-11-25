import { ErrorCode, ErrorScrapeLog, TransportableError } from "../../lib/error";
import { logsMessages } from "../../service/defaults";
import { installedService } from "../../service/service";
import type { Meta } from ".";
import type { Engine, FeatureFlag } from "./engines";

const defaultMessages = logsMessages();
const messages = () => installedService()?.modules.messages ?? defaultMessages;

export class EngineError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }

  formatEngineLog(engine: string): string {
    return `Engine ${engine} could not scrape the page.`;
  }
}

/** A route the team's US-only restriction rules out, because no US-based vendor serves it. */
export class UsOnlyUnavailableError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["US_ONLY_UNAVAILABLE"];

  constructor(message: string) {
    super("US_ONLY_UNAVAILABLE", message);
  }

  get endsEngineLoop(): boolean {
    return true;
  }

  get propagateFromExtraction(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 403;
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UsOnlyUnavailableError(data.message);
    x.stack = data.stack;
    return x;
  }
}

/** Parsing the team's reserved capacity restriction rules out, because the PDF service could not run, or did not confirm running, it there. */
export class ReservedCapacityUnavailableError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "RESERVED_CAPACITY_UNAVAILABLE",
  ];

  constructor(
    message = "PDF processing is unavailable for this team's configuration. Please retry later.",
  ) {
    super("RESERVED_CAPACITY_UNAVAILABLE", message);
  }

  get endsEngineLoop(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 403;
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ReservedCapacityUnavailableError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class NoEnginesLeftError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_ALL_ENGINES_FAILED"];

  public fallbackList: Engine[];

  constructor(fallbackList: Engine[]) {
    const enginesTriedStr = fallbackList.join(", ");
    const message = `All scraping engines failed to retrieve content from this URL. Engines tried: [${enginesTriedStr}]. This usually happens when: (1) The URL is invalid or the page doesn't exist (404), (2) The website is blocking automated access, (3) The website is down or unreachable, (4) The page requires authentication. Double check the URL is correct and accessible in a browser. ${messages().allEnginesFailedContact()}`;

    super("SCRAPE_ALL_ENGINES_FAILED", message);
    this.fallbackList = fallbackList;
  }

  serialize() {
    return {
      ...super.serialize(),
      fallbackList: this.fallbackList,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new NoEnginesLeftError(data.fallbackList);
    x.stack = data.stack;
    return x;
  }
}

export class AddFeatureError extends Error {
  public featureFlags: FeatureFlag[];
  public pdfPrefetch: Meta["pdfPrefetch"];
  public documentPrefetch: Meta["documentPrefetch"];
  public imagePrefetch: Meta["imagePrefetch"];

  constructor(
    featureFlags: FeatureFlag[],
    pdfPrefetch?: Meta["pdfPrefetch"],
    documentPrefetch?: Meta["documentPrefetch"],
    imagePrefetch?: Meta["imagePrefetch"],
  ) {
    super("New feature flags have been discovered: " + featureFlags.join(", "));
    this.featureFlags = featureFlags;
    this.pdfPrefetch = pdfPrefetch;
    this.documentPrefetch = documentPrefetch;
    this.imagePrefetch = imagePrefetch;
  }

  get endsEngineLoop(): boolean {
    return true;
  }
}

export class RemoveFeatureError extends Error {
  public featureFlags: FeatureFlag[];

  constructor(featureFlags: FeatureFlag[]) {
    super(
      "Incorrect feature flags have been discovered: " +
        featureFlags.join(", "),
    );
    this.featureFlags = featureFlags;
  }

  get endsEngineLoop(): boolean {
    return true;
  }
}

export class SSLError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_SSL_ERROR"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(
    public skipTlsVerification: boolean,
    public zeroDataRetention = false,
  ) {
    super(
      "SCRAPE_SSL_ERROR",
      "An SSL/TLS certificate error occurred while trying to establish a secure connection to this website. " +
        (zeroDataRetention
          ? "This usually happens when a website has an expired, self-signed, or misconfigured SSL certificate. TLS verification can't be bypassed for zero data retention requests, so `skipTlsVerification` has no effect."
          : skipTlsVerification
            ? "You already have `skipTlsVerification: true` enabled, which means the website's TLS configuration is severely broken (not just an expired or self-signed certificate). Possible solutions: (1) Try the plain HTTP version of the URL (http:// instead of https://), (2) The website may be completely down, or (3) Contact the website administrator about their broken SSL configuration."
            : "This usually happens when a website has an expired, self-signed, or misconfigured SSL certificate. If you trust this website and are not submitting sensitive data, you can bypass this error by setting `skipTlsVerification: true` in your scrape request. Note: Only do this for trusted sites as it disables certificate validation."),
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      skipTlsVerification: this.skipTlsVerification,
      zeroDataRetention: this.zeroDataRetention,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SSLError(data.skipTlsVerification, data.zeroDataRetention);
    x.stack = data.stack;
    return x;
  }
}

type ExchangeRefusalCode =
  | "THIRD_PARTY_DATA_NOT_FOUND"
  | "THIRD_PARTY_DATA_UNSUPPORTED_URL"
  | "THIRD_PARTY_DATA_NOT_ENABLED"
  | "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED";

// A definitive answer from the Exchange about this URL: the provider holds no
// record for it, does not serve it, or the team is not entitled to the
// provider. Another attempt cannot change it, so it surfaces as-is instead of
// as an engine failure.
export class ExchangeRefusedError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "THIRD_PARTY_DATA_NOT_FOUND",
    "THIRD_PARTY_DATA_UNSUPPORTED_URL",
    "THIRD_PARTY_DATA_NOT_ENABLED",
    "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
  ];

  constructor(code: ExchangeRefusalCode, message: string) {
    super(code, message);
  }

  get endsEngineLoop(): boolean {
    return true;
  }

  get httpStatus(): number {
    switch (this.code as ExchangeRefusalCode) {
      case "THIRD_PARTY_DATA_NOT_FOUND":
        return 404;
      case "THIRD_PARTY_DATA_UNSUPPORTED_URL":
        return 400;
      case "THIRD_PARTY_DATA_NOT_ENABLED":
      case "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED":
        return 403;
    }
  }

  static deserialize(
    code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ExchangeRefusedError(
      code as ExchangeRefusalCode,
      data.message,
    );
    x.stack = data.stack;
    return x;
  }
}

export class SiteError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_SITE_ERROR"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(public errorCode: string) {
    const errorExplanations: Record<string, string> = {
      ERR_TUNNEL_CONNECTION_FAILED:
        "Firecrawl encountered an internal proxy error while establishing the tunnel.",
      ERR_TIMED_OUT:
        "The connection timed out. The server is not responding or is too slow.",
      ERR_BLOCKED_BY_CLIENT:
        "The request was blocked by the client, possibly due to an ad blocker or network policy.",
      ERR_CONNECTION_CLOSED:
        "The connection was closed unexpectedly by the server.",
      ERR_HTTP2_PROTOCOL_ERROR:
        "An HTTP/2 protocol error occurred. The server may have misconfigured HTTP/2.",
      ERR_EMPTY_RESPONSE:
        "The server closed the connection without sending any response.",
      ERR_PROXY_CONNECTION_FAILED:
        "Firecrawl encountered an internal proxy error while connecting to the proxy.",
      ERR_CONNECTION_RESET:
        "The connection was reset by the peer. The server may have dropped the connection.",
      ERR_TOO_MANY_REDIRECTS:
        "The page has too many redirects. The website may be misconfigured.",
    };

    const isProxyError =
      errorCode === "ERR_TUNNEL_CONNECTION_FAILED" ||
      errorCode === "ERR_PROXY_CONNECTION_FAILED";

    const explanation =
      errorExplanations[errorCode] ||
      "The website returned an error or could not be loaded properly.";

    const followUp = isProxyError
      ? "This is an internal Firecrawl proxy error. Please retry or contact support."
      : "Please verify the URL is correct and the website is accessible.";

    super(
      "SCRAPE_SITE_ERROR",
      `The URL failed to load in the browser with error code "${errorCode}". ${explanation} ${followUp}`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      errorCode: this.errorCode,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SiteError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class ProxySelectionError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_PROXY_SELECTION_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor() {
    super(
      "SCRAPE_PROXY_SELECTION_ERROR",
      "The specified proxy location could not be selected for this scrape request. This happens when the requested geographic location or proxy type is not available or is incompatible with other options in your request. To fix this: (1) Try a different location value (e.g., 'US', 'GB', 'DE'), (2) Remove the location parameter to use the default, or (3) Check that your proxy settings are compatible with other scrape options you've specified.",
    );
  }

  serialize() {
    return {
      ...super.serialize(),
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ProxySelectionError();
    x.stack = data.stack;
    return x;
  }
}

export class SiteRestrictionError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_SITE_RESTRICTION_BLOCKED",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  get scrapeLog(): ErrorScrapeLog {
    return {
      errorType: "SiteRestrictionError",
      message: "scrapeURL: Site restriction returned (Safe Mode)",
      context: { error: this },
    };
  }

  constructor() {
    super(
      "SCRAPE_SITE_RESTRICTION_BLOCKED",
      "This site restricts automated access to the requested content. Safe Mode is enabled for your organization, so the site's restriction is returned instead of being worked around.",
    );
  }

  serialize() {
    return {
      ...super.serialize(),
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SiteRestrictionError();
    x.stack = data.stack;
    return x;
  }
}

// Fire Engine failed the scrape on a site block that it marked as not worth
// retrying on another exit or tier: an instant-block rule with
// retryWithStealth false, such as a sign-in wall a site shows every signed-out
// visitor. The other engines get the same page, so the waterfall ends the
// scrape on it with the usual NoEnginesLeftError instead of trying them.
// Internal only; it never reaches the API response.
export class SiteBlockNoRetryError extends Error {
  constructor(public fireEngineError: string) {
    super(
      `Fire Engine reported a site block that a retry does not get past: ${fireEngineError}`,
    );
  }

  get abortsEngineRace(): boolean {
    return true;
  }
}

// Whether a failed Fire Engine job is such a block. Fire Engine sends
// retryWithStealth only when true, so "no retry" is site_protection without it,
// limited to instant-block failures: other site_protection failures that skip
// the stealth retry (a challenge solver at capacity, say) still go through the
// waterfall.
export function isNoRetrySiteBlock(
  failed: { failureReason?: "site_protection"; retryWithStealth?: boolean },
  error: unknown,
): error is string {
  return (
    failed.failureReason === "site_protection" &&
    !failed.retryWithStealth &&
    typeof error === "string" &&
    error.includes("instant-block:")
  );
}

export class ActionError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_ACTION_ERROR"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(public errorCode: string) {
    super(
      "SCRAPE_ACTION_ERROR",
      "Action(s) failed to complete. Error code: " + errorCode,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      errorCode: this.errorCode,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ActionError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class UnsupportedFileError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_UNSUPPORTED_FILE_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(public reason: string) {
    super(
      "SCRAPE_UNSUPPORTED_FILE_ERROR",
      `The URL returned a file type that Firecrawl cannot process: ${reason}. Firecrawl supports HTML web pages, PDFs, and common document formats. Raster images (PNG, JPEG, JPEG 2000, TIFF, GIF, BMP, WebP, AVIF) are OCR'd when the parsers option includes "image" (the default), where image parsing is available. Other binary files like videos, executables, archives, and other image formats are not supported. If you expected this URL to return a web page, the server may be misconfigured or returning the wrong content type.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnsupportedFileError(data.reason);
    x.stack = data.stack;
    return x;
  }
}

export class PDFAntibotError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_PDF_ANTIBOT_ERROR"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor() {
    super("SCRAPE_PDF_ANTIBOT_ERROR", "PDF scrape was prevented by anti-bot");
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class PDFFetchProxyError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_PDF_FETCH_PROXY_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor() {
    super(
      "SCRAPE_PDF_FETCH_PROXY_ERROR",
      messages().fileFetchProxyError("PDF"),
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFFetchProxyError();
    x.stack = data.stack;
    return x;
  }
}

export class PDFInsufficientTimeError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(
    public pageCount: number,
    public minTimeout: number,
  ) {
    super(
      "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
      `The PDF has ${pageCount} pages, which requires more processing time than your current timeout allows. PDF processing time scales with page count - larger PDFs need longer timeouts. To successfully scrape this PDF, increase the timeout parameter in your scrape request to at least ${minTimeout}ms (${Math.ceil(minTimeout / 1000)} seconds). For very large PDFs, consider using a timeout of ${Math.ceil((minTimeout * 1.5) / 1000)} seconds or more to account for network variability.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      pageCount: this.pageCount,
      minTimeout: this.minTimeout,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFInsufficientTimeError(data.pageCount, data.minTimeout);
    x.stack = data.stack;
    return x;
  }
}

export class DNSResolutionError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_DNS_RESOLUTION_ERROR"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(public hostname: string) {
    super(
      "SCRAPE_DNS_RESOLUTION_ERROR",
      `DNS resolution failed for hostname "${hostname}". This means the domain name could not be translated to an IP address. Possible causes: (1) The domain name is misspelled (check for typos), (2) The domain does not exist or has expired, (3) The DNS servers are temporarily unavailable, or (4) The domain was recently registered and DNS has not propagated yet. Please verify the URL is correct and the website exists.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      hostname: this.hostname,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DNSResolutionError(data.hostname);
    x.stack = data.stack;
    return x;
  }
}

export class IndexMissError extends EngineError {
  constructor() {
    super("Index doesn't have the page we're looking for");
  }

  override formatEngineLog(engine: string): string {
    return `Engine ${engine} could not find the page in the index.`;
  }
}

export class NoCachedDataError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_NO_CACHED_DATA"];

  get endsEngineLoop(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 404;
  }

  constructor() {
    super(
      "SCRAPE_NO_CACHED_DATA",
      "No cached data is available for this URL that meets your specified age requirements. This error occurs when you use the minAge parameter to request only cached data, but Firecrawl has no cached version of this URL (or no version within the specified age range). To resolve this, either remove the minAge parameter to allow a fresh scrape, or try again later after the URL has been scraped and cached.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new NoCachedDataError();
    x.stack = data.stack;
    return x;
  }
}

export class LockdownMissError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_LOCKDOWN_CACHE_MISS"];

  get httpStatus(): number {
    return 404;
  }

  constructor() {
    super(
      "SCRAPE_LOCKDOWN_CACHE_MISS",
      "No cached data is available for this request in lockdown mode. Lockdown mode only serves previously cached responses and never makes outbound requests. To resolve this, either disable lockdown mode to allow a fresh scrape, or try again after the URL has been scraped and cached.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new LockdownMissError();
    x.stack = data.stack;
    return x;
  }
}

export class ZDRViolationError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_ZDR_VIOLATION_ERROR"];

  constructor(public feature: string) {
    super(
      "SCRAPE_ZDR_VIOLATION_ERROR",
      `The feature "${feature}" is not available when using Zero Data Retention (ZDR) mode. ZDR mode ensures that no scraped content is stored on Firecrawl servers, but this limits certain features that require data storage (such as the index engine, certain proxy modes, or advanced processing). To use this feature, you need to disable ZDR mode. Contact support@firecrawl.com if you need help.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      feature: this.feature,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ZDRViolationError(data.feature);
    x.stack = data.stack;
    return x;
  }
}

export class PDFOCRRequiredError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_PDF_OCR_REQUIRED"];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor(public pdfType: string) {
    super(
      "SCRAPE_PDF_OCR_REQUIRED",
      `This PDF is ${pdfType === "Scanned" ? "scanned" : "image-based"} and requires OCR for text extraction, but the requested PDF mode is "fast" which only supports text-based PDFs. To process this PDF, use mode "auto" (which falls back to OCR automatically) or mode "ocr" (which forces OCR processing). Example: parsers: [{ type: "pdf", mode: "auto" }]`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      pdfType: this.pdfType,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFOCRRequiredError(data.pdfType);
    x.stack = data.stack;
    return x;
  }
}

export class PDFPrefetchFailed extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_PDF_PREFETCH_FAILED"];

  constructor() {
    const message = `Failed to prefetch the PDF file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the PDF is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. ${messages().filePrefetchFailedContact()}`;

    super("SCRAPE_PDF_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentAntibotError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor() {
    super(
      "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
      "Document scrape was prevented by anti-bot",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentFetchProxyError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_DOCUMENT_FETCH_PROXY_ERROR",
  ];

  get endsEngineLoop(): boolean {
    return true;
  }

  constructor() {
    super(
      "SCRAPE_DOCUMENT_FETCH_PROXY_ERROR",
      messages().fileFetchProxyError("document"),
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentFetchProxyError();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentPrefetchFailed extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_DOCUMENT_PREFETCH_FAILED",
  ];

  constructor() {
    const message = `Failed to prefetch the document file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the document (DOCX, XLSX, etc.) is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. ${messages().filePrefetchFailedContact()}`;

    super("SCRAPE_DOCUMENT_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class AgentIndexOnlyError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["AGENT_INDEX_ONLY"];

  get endsEngineLoop(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 403;
  }

  get httpResponseFields(): Record<string, unknown> {
    return {
      sponsor_status: "pending",
      login_url: "https://firecrawl.dev/signin",
    };
  }

  constructor() {
    super(
      "AGENT_INDEX_ONLY",
      "This page is not available in Firecrawl's index. Your API key was provisioned by an agent and the account has not yet been confirmed by the account holder. Until the account is confirmed, only pages already in Firecrawl's index can be served. Please ask the account holder to check their email and confirm the account to unlock full scraping capabilities, or visit https://firecrawl.dev/signin to claim the account.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new AgentIndexOnlyError();
    x.stack = data.stack;
    return x;
  }
}

export class PromptInjectionDetectedError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_PROMPT_INJECTION_DETECTED",
  ];

  constructor(message?: string) {
    super(
      "SCRAPE_PROMPT_INJECTION_DETECTED",
      message ??
        "The scraped page content appears to contain a prompt injection attempt, so the scrape was aborted for safety.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PromptInjectionDetectedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class PaywalledContentError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_PAYWALLED_CONTENT"];

  get stopsCrawlRetry(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 403;
  }

  get scrapeLog(): ErrorScrapeLog {
    return {
      errorType: "PaywalledContentError",
      message: "scrapeURL: Paywalled page refused by Safe Mode",
    };
  }

  constructor(message?: string) {
    super(
      "SCRAPE_PAYWALLED_CONTENT",
      message ??
        "The page is marked as paywalled (schema.org isAccessibleForFree is false), so Safe Mode refused the scrape.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PaywalledContentError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class JsonExtractionContentTooLargeError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "SCRAPE_JSON_CONTENT_TOO_LARGE",
  ];

  constructor(message?: string) {
    super(
      "SCRAPE_JSON_CONTENT_TOO_LARGE",
      message ??
        "The scraped page content is too large for JSON extraction, so extraction was aborted.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new JsonExtractionContentTooLargeError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class FEPageLoadFailed extends EngineError {
  constructor() {
    super(
      "The page failed to load with the specified timeout. Please increase the timeout parameter in your request.",
    );
  }

  override formatEngineLog(_engine: string): string {
    return "FEPageLoadFailed encountered";
  }
}

export class EngineSnipedError extends Error {
  name = "EngineSnipedError";

  constructor() {
    super("Engine got sniped");
  }
}

export class EngineUnsuccessfulError extends Error {
  name = "EngineUnsuccessfulError";

  constructor(engine: Engine) {
    super(`Engine ${engine} was unsuccessful`);
  }
}

export class WaterfallNextEngineSignal extends Error {
  name = "WaterfallNextEngineSignal";

  constructor() {
    super("Waterfall next engine");
  }
}

export class ScrapeJobCancelledError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_JOB_CANCELLED"];

  constructor() {
    super(
      "SCRAPE_JOB_CANCELLED",
      "Scrape job was cancelled before completion.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ScrapeJobCancelledError();
    x.stack = data.stack;
    return x;
  }
}

export type ScrapeRetryLimitReason =
  | "global"
  | "feature_toggle"
  | "feature_removal"
  | "pdf_antibot"
  | "document_antibot"
  | "pdf_fetch_proxy"
  | "document_fetch_proxy";

export type ScrapeRetryStats = {
  totalAttempts: number;
  addFeatureAttempts: number;
  removeFeatureAttempts: number;
  pdfAntibotAttempts: number;
  documentAntibotAttempts: number;
  pdfFetchProxyAttempts: number;
  documentFetchProxyAttempts: number;
};

export class ScrapeRetryLimitError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = ["SCRAPE_RETRY_LIMIT"];

  constructor(
    public reason: ScrapeRetryLimitReason,
    public stats: ScrapeRetryStats,
  ) {
    super(
      "SCRAPE_RETRY_LIMIT",
      `Scrape aborted after exceeding retry limit (${reason}).`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
      stats: this.stats,
    };
  }

  static deserialize(
    _: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    // Counters added after this error first shipped default to 0: during a
    // rolling deploy, workers on the older build serialize stats payloads
    // without them, and the ScrapeRetryStats contract types them as numbers.
    const x = new ScrapeRetryLimitError(data.reason, {
      ...data.stats,
      pdfFetchProxyAttempts: data.stats.pdfFetchProxyAttempts ?? 0,
      documentFetchProxyAttempts: data.stats.documentFetchProxyAttempts ?? 0,
    });
    x.stack = data.stack;
    return x;
  }
}
