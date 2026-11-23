import {
  ActionsNotSupportedError,
  ConcurrencyQueueTimeoutError,
  CrawlDenialError,
  type ErrorCode,
  isTransportableError,
  MapFailedError,
  MapTimeoutError,
  RacedRedirectError,
  ScrapeJobTimeoutError,
  SitemapError,
  TransportableError,
  type TransportableErrorClass,
  UnknownError,
  UnsupportedSiteError,
} from "./error";
import {
  ActionError,
  DNSResolutionError,
  UnsupportedFileError,
  PDFAntibotError,
  DocumentAntibotError,
  PDFFetchProxyError,
  DocumentFetchProxyError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  NoEnginesLeftError,
  ZDRViolationError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  SiteError,
  SiteRestrictionError,
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
  MediaAccessDeniedError,
  PromptInjectionDetectedError,
  PaywalledContentError,
  JsonExtractionContentTooLargeError,
  UsOnlyUnavailableError,
  ReservedCapacityUnavailableError,
  ExchangeRefusedError,
} from "../scraper/scrapeURL/error";
import { UnsafeDomainBlockedError } from "./threat-protection/error";
import {
  ThirdPartyDataTermsRequiredError,
  ThirdPartyDataUnsupportedOptionError,
} from "./exchange";
import { service } from "../service";

/**
 * The service's own error classes. Reading a code that no class carries gives
 * a plain TransportableError.
 */
export const coreErrors: TransportableErrorClass[] = [
  ThirdPartyDataTermsRequiredError,
  ExchangeRefusedError,
  ThirdPartyDataUnsupportedOptionError,
  SiteRestrictionError,
  ScrapeJobTimeoutError,
  MapTimeoutError,
  UnknownError,
  NoEnginesLeftError,
  SSLError,
  SiteError,
  ProxySelectionError,
  PDFPrefetchFailed,
  DocumentPrefetchFailed,
  ScrapeJobCancelledError,
  ScrapeRetryLimitError,
  ZDRViolationError,
  DNSResolutionError,
  PDFInsufficientTimeError,
  PDFAntibotError,
  PDFFetchProxyError,
  PDFOCRRequiredError,
  DocumentAntibotError,
  DocumentFetchProxyError,
  UnsupportedFileError,
  NoCachedDataError,
  LockdownMissError,
  ActionError,
  ActionsNotSupportedError,
  BrandingNotSupportedError,
  AgentIndexOnlyError,
  RacedRedirectError,
  SitemapError,
  CrawlDenialError,
  UnsupportedSiteError,
  AudioUnsupportedUrlError,
  VideoUnsupportedUrlError,
  MediaAccessDeniedError,
  PromptInjectionDetectedError,
  PaywalledContentError,
  JsonExtractionContentTooLargeError,
  UsOnlyUnavailableError,
  ReservedCapacityUnavailableError,
  MapFailedError,
  ConcurrencyQueueTimeoutError,
  UnsafeDomainBlockedError,
];

export function serializeTransportableError(error: TransportableError) {
  return `${error.code}|${JSON.stringify(error.serialize())}`;
}

/**
 * The wire form of anything a job throws. What is not a transportable error
 * goes out as UNKNOWN_ERROR.
 */
export function serializeThrownError(error: unknown) {
  return serializeTransportableError(
    isTransportableError(error) ? error : new UnknownError(error),
  );
}

/**
 * Returns null when `data` is not a serialized error; callers also pass plain
 * error messages. A code that no registered class carries gives a plain
 * TransportableError.
 */
export function deserializeTransportableError(
  data: string,
): TransportableError | null {
  const [code, ...serialized] = data.split("|");
  if (serialized.length === 0) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(serialized.join("|"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const errorClass = service.errors.classFor(code);
  if (errorClass) {
    return errorClass.deserialize(code as ErrorCode, payload);
  }

  const { message, stack, cause } = payload as Record<string, unknown>;
  if (!/^\S+$/.test(code) || typeof message !== "string") {
    return null;
  }
  return TransportableError.deserialize(code as ErrorCode, {
    message,
    stack: typeof stack === "string" ? stack : undefined,
    cause,
  });
}
