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
 * The size of the longest reason that every queue backend keeps whole for a
 * failed job, in bytes of UTF-8. A serialized error that is cut cannot be read
 * back.
 */
export const MAX_SERIALIZED_ERROR_BYTES = 90 * 1024;

// What a stack or a message is cut to in an error that is longer than that.
const SHORTENED_LENGTH = 4096;

function shortened(text: string) {
  if (text.length <= SHORTENED_LENGTH) {
    return text;
  }
  // A character outside the basic plane takes two code units. A cut between
  // them would leave half a character, so the first half goes too.
  const kept = text.slice(0, SHORTENED_LENGTH).replace(/[\uD800-\uDBFF]$/, "");
  return `${kept}... [truncated]`;
}

/**
 * The wire form of anything a job throws. What is not a transportable error
 * goes out as UNKNOWN_ERROR.
 *
 * An error crosses with its code even when it cannot be written as it is. A
 * cause that JSON cannot write is left out. An error that is too long for the
 * queue to keep whole gets its stack shortened, then its message, and then
 * loses its cause, until it fits.
 */
export function serializeThrownError(error: unknown) {
  const thrown = isTransportableError(error) ? error : new UnknownError(error);
  let payload = thrown.serialize();
  const write = (fields: typeof payload) =>
    `${thrown.code}|${JSON.stringify(fields)}`;

  let serialized: string;
  try {
    serialized = write(payload);
  } catch {
    // Only the cause can hold a value that JSON cannot write, such as an
    // object that refers to itself.
    payload = { ...payload, cause: undefined };
    serialized = write(payload);
  }
  const fits = () =>
    Buffer.byteLength(serialized, "utf8") <= MAX_SERIALIZED_ERROR_BYTES;
  if (fits()) {
    return serialized;
  }

  const stack = payload.stack && shortened(payload.stack);
  const message = shortened(payload.message);
  for (const shorter of [
    { ...payload, stack },
    { ...payload, stack, message },
    { ...payload, stack, message, cause: undefined },
  ]) {
    serialized = write(shorter);
    if (fits()) {
      break;
    }
  }
  return serialized;
}

/**
 * Returns null when `data` is not a serialized error; callers also pass plain
 * error messages. A code that no registered class carries gives a plain
 * TransportableError.
 */
export function deserializeTransportableError(data: string): any {
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
