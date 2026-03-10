import { ErrorCodes, TransportableError } from "../../lib/error";
import { Meta } from ".";
import { Engine, FeatureFlag } from "./engines";
import { isSelfHosted } from "../../lib/deployment";

export class EngineError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class NoEnginesLeftError extends TransportableError {
  public fallbackList: Engine[];

  constructor(fallbackList: Engine[]) {
    const enginesTriedStr = fallbackList.join(", ");
    const message = isSelfHosted()
      ? `All scraping engines failed to retrieve content from this URL. Engines tried: [${enginesTriedStr}]. This usually happens when: (1) The URL is invalid or the page doesn't exist (404), (2) The website is blocking automated access, (3) The website is down or unreachable, (4) The page requires authentication. Double check the URL is correct and accessible in a browser. Check your server logs for more detailed error information from each engine.`
      : `All scraping engines failed to retrieve content from this URL. Engines tried: [${enginesTriedStr}]. This usually happens when: (1) The URL is invalid or the page doesn't exist (404), (2) The website is blocking automated access, (3) The website is down or unreachable, (4) The page requires authentication. Double check the URL is correct and accessible in a browser. If the issue persists, contact us at help@firecrawl.com with your request ID for investigation.`;

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
    _: ErrorCodes,
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

  constructor(
    featureFlags: FeatureFlag[],
    pdfPrefetch?: Meta["pdfPrefetch"],
    documentPrefetch?: Meta["documentPrefetch"],
  ) {
    super("New feature flags have been discovered: " + featureFlags.join(", "));
    this.featureFlags = featureFlags;
    this.pdfPrefetch = pdfPrefetch;
    this.documentPrefetch = documentPrefetch;
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
}

export class SSLError extends TransportableError {
  constructor(public skipTlsVerification: boolean) {
    super(
      "SCRAPE_SSL_ERROR",
      "An SSL/TLS certificate error occurred while trying to establish a secure connection to this website. " +
        (skipTlsVerification
          ? "You already have `skipTlsVerification: true` enabled, which means the website's TLS configuration is severely broken (not just an expired or self-signed certificate). Possible solutions: (1) Try the plain HTTP version of the URL (http:// instead of https://), (2) The website may be completely down, or (3) Contact the website administrator about their broken SSL configuration."
          : "This usually happens when a website has an expired, self-signed, or misconfigured SSL certificate. If you trust this website and are not submitting sensitive data, you can bypass this error by setting `skipTlsVerification: true` in your scrape request. Note: Only do this for trusted sites as it disables certificate validation."),
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      skipTlsVerification: this.skipTlsVerification,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SSLError(data.skipTlsVerification);
    x.stack = data.stack;
    return x;
  }
}

export class SiteError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SiteError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class ProxySelectionError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ProxySelectionError();
    x.stack = data.stack;
    return x;
  }
}

export class ActionError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ActionError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class UnsupportedFileError extends TransportableError {
  constructor(public reason: string) {
    super(
      "SCRAPE_UNSUPPORTED_FILE_ERROR",
      `The URL returned a file type that Firecrawl cannot process: ${reason}. Firecrawl supports HTML web pages, PDFs, and common document formats. Binary files like images, videos, executables, and archives are not supported. If you expected this URL to return a web page, the server may be misconfigured or returning the wrong content type.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnsupportedFileError(data.reason);
    x.stack = data.stack;
    return x;
  }
}

export class PDFAntibotError extends TransportableError {
  constructor() {
    super("SCRAPE_PDF_ANTIBOT_ERROR", "PDF scrape was prevented by anti-bot");
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class PDFInsufficientTimeError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFInsufficientTimeError(data.pageCount, data.minTimeout);
    x.stack = data.stack;
    return x;
  }
}

export class DNSResolutionError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DNSResolutionError(data.hostname);
    x.stack = data.stack;
    return x;
  }
}

export class IndexMissError extends Error {
  constructor() {
    super("Index doesn't have the page we're looking for");
  }
}

export class NoCachedDataError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new NoCachedDataError();
    x.stack = data.stack;
    return x;
  }
}

export class ZDRViolationError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ZDRViolationError(data.feature);
    x.stack = data.stack;
    return x;
  }
}

export class PDFOCRRequiredError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFOCRRequiredError(data.pdfType);
    x.stack = data.stack;
    return x;
  }
}

export class PDFPrefetchFailed extends TransportableError {
  constructor() {
    const message = isSelfHosted()
      ? "Failed to prefetch the PDF file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the PDF is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. Check your server logs for more details about the specific protection mechanism encountered."
      : "Failed to prefetch the PDF file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the PDF is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. If this is a business-critical URL, please contact help@firecrawl.com with the URL and we can investigate adding specific support for this site.";

    super("SCRAPE_PDF_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentAntibotError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentPrefetchFailed extends TransportableError {
  constructor() {
    const message = isSelfHosted()
      ? "Failed to prefetch the document file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the document (DOCX, XLSX, etc.) is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. Check your server logs for more details about the specific protection mechanism encountered."
      : "Failed to prefetch the document file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the document (DOCX, XLSX, etc.) is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. If this is a business-critical URL, please contact help@firecrawl.com with the URL and we can investigate adding specific support for this site.";

    super("SCRAPE_DOCUMENT_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class BrandingNotSupportedError extends TransportableError {
  constructor(message: string) {
    super("SCRAPE_BRANDING_NOT_SUPPORTED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new BrandingNotSupportedError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class FEPageLoadFailed extends Error {
  constructor() {
    super(
      "The page failed to load with the specified timeout. Please increase the timeout parameter in your request.",
    );
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
    _: ErrorCodes,
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
  | "document_antibot";

export type ScrapeRetryStats = {
  totalAttempts: number;
  addFeatureAttempts: number;
  removeFeatureAttempts: number;
  pdfAntibotAttempts: number;
  documentAntibotAttempts: number;
};

export class ScrapeRetryLimitError extends TransportableError {
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
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ScrapeRetryLimitError(data.reason, data.stats);
    x.stack = data.stack;
    return x;
  }
}
