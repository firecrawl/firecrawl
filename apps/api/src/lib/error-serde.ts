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
  NoEnginesLeftError,
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
  ScrapeRetryLimitError,
  BrandingNotSupportedError,
  AudioUnsupportedUrlError,
  VideoUnsupportedUrlError,
  XTwitterConfigurationError,
} from "../scraper/scrapeURL/error";
import { UnsafeDomainBlockedError } from "./threat-protection/error";

// TODO: figure out correct typing for this
const errorMap: Record<ErrorCodes, any> = {
  // Terms responses are API-level, never transported through workers.
  THIRD_PARTY_DATA_TERMS_REQUIRED: null,
  SCRAPE_TIMEOUT: ScrapeJobTimeoutError,
  MAP_TIMEOUT: MapTimeoutError,
  UNKNOWN_ERROR: UnknownError,
  SCRAPE_ALL_ENGINES_FAILED: NoEnginesLeftError,
  SCRAPE_SSL_ERROR: SSLError,
  SCRAPE_SITE_ERROR: SiteError,
  SCRAPE_PROXY_SELECTION_ERROR: ProxySelectionError,
  SCRAPE_PDF_PREFETCH_FAILED: PDFPrefetchFailed,
  SCRAPE_DOCUMENT_PREFETCH_FAILED: DocumentPrefetchFailed,
  SCRAPE_JOB_CANCELLED: ScrapeJobCancelledError,
  SCRAPE_RETRY_LIMIT: ScrapeRetryLimitError,
  SCRAPE_ZDR_VIOLATION_ERROR: ZDRViolationError,
  SCRAPE_DNS_RESOLUTION_ERROR: DNSResolutionError,
  SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: PDFInsufficientTimeError,
  SCRAPE_PDF_ANTIBOT_ERROR: PDFAntibotError,
  SCRAPE_PDF_OCR_REQUIRED: PDFOCRRequiredError,
  SCRAPE_DOCUMENT_ANTIBOT_ERROR: DocumentAntibotError,
  SCRAPE_UNSUPPORTED_FILE_ERROR: UnsupportedFileError,
  SCRAPE_NO_CACHED_DATA: NoCachedDataError,
  SCRAPE_LOCKDOWN_CACHE_MISS: LockdownMissError,
  SCRAPE_ACTION_ERROR: ActionError,
  SCRAPE_ACTIONS_NOT_SUPPORTED: ActionsNotSupportedError,
  SCRAPE_BRANDING_NOT_SUPPORTED: BrandingNotSupportedError,
  AGENT_INDEX_ONLY: AgentIndexOnlyError,
  SCRAPE_RACED_REDIRECT_ERROR: RacedRedirectError,
  SCRAPE_SITEMAP_ERROR: SitemapError,
  CRAWL_DENIAL: CrawlDenialError,
  SCRAPE_AUDIO_UNSUPPORTED_URL: AudioUnsupportedUrlError,
  SCRAPE_VIDEO_UNSUPPORTED_URL: VideoUnsupportedUrlError,
  SCRAPE_X_TWITTER_CONFIGURATION_ERROR: XTwitterConfigurationError,
  MAP_FAILED: MapFailedError,
  unsafe_domain_blocked: UnsafeDomainBlockedError,

  // Zod errors
  BAD_REQUEST: null,
  BAD_REQUEST_INVALID_JSON: null,
  PARSE_UNSUPPORTED_OPTIONS: null,
};

export function serializeTransportableError(error: TransportableError) {
  return `${error.code}|${JSON.stringify(error.serialize())}`;
}

export function deserializeTransportableError(
  data: string,
): InstanceType<(typeof errorMap)[keyof typeof errorMap]> | null {
  const [code, ...serialized] = data.split("|");
  const x = errorMap[code];
  if (!x) {
    return null;
  }
  return x.deserialize(code, JSON.parse(serialized.join("|")));
}
