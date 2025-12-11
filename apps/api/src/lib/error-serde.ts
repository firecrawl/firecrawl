import {
  CrawlDenialError,
  ErrorCodes,
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
  NoEnginesLeftError,
  ZDRViolationError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  SiteError,
  SSLError,
  ProxySelectionError,
  NoCachedDataError,
} from "../scraper/scrapeURL/error";

// TODO: figure out correct typing for this
const errorMap: Record<ErrorCodes, any> = {
  SCRAPE_TIMEOUT: ScrapeJobTimeoutError,
  MAP_TIMEOUT: MapTimeoutError,
  UNKNOWN_ERROR: UnknownError,
  SCRAPE_ALL_ENGINES_FAILED: NoEnginesLeftError,
  SCRAPE_SSL_ERROR: SSLError,
  SCRAPE_SITE_ERROR: SiteError,
  SCRAPE_PROXY_SELECTION_ERROR: ProxySelectionError,
  SCRAPE_PDF_PREFETCH_FAILED: PDFPrefetchFailed,
  SCRAPE_DOCUMENT_PREFETCH_FAILED: DocumentPrefetchFailed,
  SCRAPE_ZDR_VIOLATION_ERROR: ZDRViolationError,
  SCRAPE_DNS_RESOLUTION_ERROR: DNSResolutionError,
  SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: PDFInsufficientTimeError,
  SCRAPE_PDF_ANTIBOT_ERROR: PDFAntibotError,
  SCRAPE_DOCUMENT_ANTIBOT_ERROR: DocumentAntibotError,
  SCRAPE_UNSUPPORTED_FILE_ERROR: UnsupportedFileError,
  SCRAPE_NO_CACHED_DATA: NoCachedDataError,
  SCRAPE_ACTION_ERROR: ActionError,
  SCRAPE_RACED_REDIRECT_ERROR: RacedRedirectError,
  SCRAPE_SITEMAP_ERROR: SitemapError,
  CRAWL_DENIAL: CrawlDenialError,

  // Zod errors
  BAD_REQUEST: null,
  BAD_REQUEST_INVALID_JSON: null,
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
