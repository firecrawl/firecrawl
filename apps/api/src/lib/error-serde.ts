import {
  ActionsNotSupportedError,
  CrawlDenialError,
  ErrorCodes,
  MapFailedError,
  MapTimeoutError,
  RacedRedirectError,
  ScrapeJobTimeoutError,
  SitemapError,
  TransportableError,
  UnknownError,
} from "./error";
import {
  ActionError,
  DNSResolutionError,
  UnsupportedFileError,
  PDFAntibotError,
  DocumentAntibotError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  ZDRViolationError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  SiteError,
  SSLError,
  ProxySelectionError,
  AgentIndexOnlyError,
  NoCachedDataError,
  LockdownMissError,
  ScrapeJobCancelledError,
  BrandingNotSupportedError,
  AudioUnsupportedUrlError,
  VideoUnsupportedUrlError,
  XTwitterConfigurationError,
} from "../scraper/scrapeURL/error";

type Reviver = (d: any) => TransportableError;

const revivers: Partial<Record<ErrorCodes, Reviver>> = {
  SCRAPE_TIMEOUT: d => new ScrapeJobTimeoutError(d.message),
  MAP_TIMEOUT: () => new MapTimeoutError(),
  UNKNOWN_ERROR: d => {
    const x = new UnknownError("");
    x.message = d.message;
    return x;
  },
  SCRAPE_SSL_ERROR: d => new SSLError(d.skipTlsVerification),
  SCRAPE_SITE_ERROR: d => new SiteError(d.errorCode),
  SCRAPE_PROXY_SELECTION_ERROR: () => new ProxySelectionError(),
  SCRAPE_PDF_PREFETCH_FAILED: () => new PDFPrefetchFailed(),
  SCRAPE_DOCUMENT_PREFETCH_FAILED: () => new DocumentPrefetchFailed(),
  SCRAPE_JOB_CANCELLED: () => new ScrapeJobCancelledError(),
  SCRAPE_ZDR_VIOLATION_ERROR: d => new ZDRViolationError(d.feature),
  SCRAPE_DNS_RESOLUTION_ERROR: d => new DNSResolutionError(d.hostname),
  SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: d =>
    new PDFInsufficientTimeError(d.pageCount, d.minTimeout),
  SCRAPE_PDF_ANTIBOT_ERROR: () => new PDFAntibotError(),
  SCRAPE_PDF_OCR_REQUIRED: d => new PDFOCRRequiredError(d.pdfType),
  SCRAPE_DOCUMENT_ANTIBOT_ERROR: () => new DocumentAntibotError(),
  SCRAPE_UNSUPPORTED_FILE_ERROR: d => new UnsupportedFileError(d.reason),
  SCRAPE_NO_CACHED_DATA: () => new NoCachedDataError(),
  SCRAPE_LOCKDOWN_CACHE_MISS: () => new LockdownMissError(),
  SCRAPE_ACTION_ERROR: d => new ActionError(d.errorCode),
  SCRAPE_ACTIONS_NOT_SUPPORTED: d => new ActionsNotSupportedError(d.message),
  SCRAPE_BRANDING_NOT_SUPPORTED: d => new BrandingNotSupportedError(d.message),
  AGENT_INDEX_ONLY: () => new AgentIndexOnlyError(),
  SCRAPE_RACED_REDIRECT_ERROR: () => new RacedRedirectError(),
  SCRAPE_SITEMAP_ERROR: d => new SitemapError(d.message, d.cause),
  CRAWL_DENIAL: d => new CrawlDenialError(d.reason),
  SCRAPE_AUDIO_UNSUPPORTED_URL: d => new AudioUnsupportedUrlError(d.message),
  SCRAPE_VIDEO_UNSUPPORTED_URL: d => new VideoUnsupportedUrlError(d.message),
  SCRAPE_X_TWITTER_CONFIGURATION_ERROR: () => new XTwitterConfigurationError(),
  MAP_FAILED: d => new MapFailedError(d.message),
};

export function serializeTransportableError(error: TransportableError): string {
  const payload: Record<string, unknown> = {
    message: error.message,
    stack: error.stack,
    cause: error.cause,
  };
  for (const [k, v] of Object.entries(error)) {
    if (k !== "code") payload[k] = v;
  }
  return `${error.code}|${JSON.stringify(payload)}`;
}

export function deserializeTransportableError(
  data: string,
): TransportableError | null {
  const sep = data.indexOf("|");
  if (sep === -1) return null;
  const code = data.slice(0, sep) as ErrorCodes;
  const reviver = revivers[code];
  if (!reviver) return null;
  const parsed = JSON.parse(data.slice(sep + 1));
  const instance = reviver(parsed);
  instance.stack = parsed.stack;
  return instance;
}
