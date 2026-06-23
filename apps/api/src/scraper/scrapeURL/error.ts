import { TransportableError } from "../../lib/error";
import type { ErrorCodes } from "../../lib/error";
import { isSelfHosted } from "../../lib/deployment";

export class EngineError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class XTwitterConfigurationError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_X_TWITTER_CONFIGURATION_ERROR",
      "X/Twitter scraping requires XAI_API_KEY to be configured.",
    );
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
}

const SITE_ERROR_EXPLANATIONS: Record<string, string> = {
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

export class SiteError extends TransportableError {
  constructor(public errorCode: string) {
    const isProxyError =
      errorCode === "ERR_TUNNEL_CONNECTION_FAILED" ||
      errorCode === "ERR_PROXY_CONNECTION_FAILED";
    const explanation =
      SITE_ERROR_EXPLANATIONS[errorCode] ||
      "The website returned an error or could not be loaded properly.";
    const followUp = isProxyError
      ? "This is an internal Firecrawl proxy error. Please retry or contact support."
      : "Please verify the URL is correct and the website is accessible.";
    super(
      "SCRAPE_SITE_ERROR",
      `The URL failed to load in the browser with error code "${errorCode}". ${explanation} ${followUp}`,
    );
  }
}

export class ProxySelectionError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_PROXY_SELECTION_ERROR",
      "The specified proxy location could not be selected for this scrape request. This happens when the requested geographic location or proxy type is not available or is incompatible with other options in your request. To fix this: (1) Try a different location value (e.g., 'US', 'GB', 'DE'), (2) Remove the location parameter to use the default, or (3) Check that your proxy settings are compatible with other scrape options you've specified.",
    );
  }
}

export class ActionError extends TransportableError {
  constructor(public errorCode: string) {
    super(
      "SCRAPE_ACTION_ERROR",
      "Action(s) failed to complete. Error code: " + errorCode,
    );
  }
}

export class UnsupportedFileError extends TransportableError {
  constructor(public reason: string) {
    super(
      "SCRAPE_UNSUPPORTED_FILE_ERROR",
      `The URL returned a file type that Firecrawl cannot process: ${reason}. Firecrawl supports HTML web pages, PDFs, and common document formats. Binary files like images, videos, executables, and archives are not supported. If you expected this URL to return a web page, the server may be misconfigured or returning the wrong content type.`,
    );
  }
}

export class PDFAntibotError extends TransportableError {
  constructor() {
    super("SCRAPE_PDF_ANTIBOT_ERROR", "PDF scrape was prevented by anti-bot");
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
}

export class DNSResolutionError extends TransportableError {
  constructor(public hostname: string) {
    super(
      "SCRAPE_DNS_RESOLUTION_ERROR",
      `DNS resolution failed for hostname "${hostname}". This means the domain name could not be translated to an IP address. Possible causes: (1) The domain name is misspelled (check for typos), (2) The domain does not exist or has expired, (3) The DNS servers are temporarily unavailable, or (4) The domain was recently registered and DNS has not propagated yet. Please verify the URL is correct and the website exists.`,
    );
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
}

export class LockdownMissError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_LOCKDOWN_CACHE_MISS",
      "Lockdown mode is enabled for this request, so only cached data from Firecrawl's index can be served. No cached version of this URL was available. To resolve this, disable lockdown mode to allow a live scrape, or try again later once this URL has been scraped and cached.",
    );
  }
}

export class ZDRViolationError extends TransportableError {
  constructor(public feature: string) {
    super(
      "SCRAPE_ZDR_VIOLATION_ERROR",
      `The feature "${feature}" is not available when using Zero Data Retention (ZDR) mode. ZDR mode ensures that no scraped content is stored on Firecrawl servers, but this limits certain features that require data storage (such as the index engine, certain proxy modes, or advanced processing). To use this feature, you need to disable ZDR mode. Contact support@firecrawl.com if you need help.`,
    );
  }
}

export class PDFOCRRequiredError extends TransportableError {
  constructor(public pdfType: string) {
    super(
      "SCRAPE_PDF_OCR_REQUIRED",
      `This PDF is ${pdfType === "Scanned" ? "scanned" : "image-based"} and requires OCR for text extraction, but the requested PDF mode is "fast" which only supports text-based PDFs. To process this PDF, use mode "auto" (which falls back to OCR automatically) or mode "ocr" (which forces OCR processing). Example: parsers: [{ type: "pdf", mode: "auto" }]`,
    );
  }
}

export class PDFPrefetchFailed extends TransportableError {
  constructor() {
    super(
      "SCRAPE_PDF_PREFETCH_FAILED",
      isSelfHosted()
        ? "Failed to prefetch the PDF file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the PDF is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. Check your server logs for more details about the specific protection mechanism encountered."
        : "Failed to prefetch the PDF file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the PDF is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. If this is a business-critical URL, please contact help@firecrawl.com with the URL and we can investigate adding specific support for this site.",
    );
  }
}

export class DocumentAntibotError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
      "Document scrape was prevented by anti-bot",
    );
  }
}

export class DocumentPrefetchFailed extends TransportableError {
  constructor() {
    super(
      "SCRAPE_DOCUMENT_PREFETCH_FAILED",
      isSelfHosted()
        ? "Failed to prefetch the document file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the document (DOCX, XLSX, etc.) is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. Check your server logs for more details about the specific protection mechanism encountered."
        : "Failed to prefetch the document file because the website's anti-bot protection blocked the initial download attempt. This typically happens when the document (DOCX, XLSX, etc.) is protected by a CAPTCHA, login wall, or aggressive bot detection. Firecrawl tried to bypass the protection but was unsuccessful. If this is a business-critical URL, please contact help@firecrawl.com with the URL and we can investigate adding specific support for this site.",
    );
  }
}

export class AgentIndexOnlyError extends TransportableError {
  constructor() {
    super(
      "AGENT_INDEX_ONLY",
      "This page is not available in Firecrawl's index. Your API key was provisioned by an agent and the account has not yet been confirmed by the account holder. Until the account is confirmed, only pages already in Firecrawl's index can be served. Please ask the account holder to check their email and confirm the account to unlock full scraping capabilities, or visit https://firecrawl.dev/signin to claim the account.",
    );
  }
}

export class AudioUnsupportedUrlError extends TransportableError {
  constructor(message?: string) {
    super(
      "SCRAPE_AUDIO_UNSUPPORTED_URL",
      message ?? "The audio format does not support the provided URL",
    );
  }
}

export class VideoUnsupportedUrlError extends TransportableError {
  constructor(message?: string) {
    super(
      "SCRAPE_VIDEO_UNSUPPORTED_URL",
      message ?? "The video format does not support the provided URL",
    );
  }

  static deserialize(
    _: ErrorCodes,
    data: { message?: string; stack?: string },
  ) {
    const x = new VideoUnsupportedUrlError(data.message);
    x.stack = data.stack;
    return x;
  }
}

export class BrandingNotSupportedError extends TransportableError {
  constructor(message: string) {
    super("SCRAPE_BRANDING_NOT_SUPPORTED", message);
  }
}

export class FEPageLoadFailed extends Error {
  constructor() {
    super(
      "The page failed to load with the specified timeout. Please increase the timeout parameter in your request.",
    );
  }
}

export class ScrapeJobCancelledError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_JOB_CANCELLED",
      "Scrape job was cancelled before completion.",
    );
  }
}
