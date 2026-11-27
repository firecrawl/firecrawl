import {
  ActionsNotSupportedError,
  ConcurrencyQueueTimeoutError,
  CrawlDenialError,
  isTransportableError,
  MapFailedError,
  MapTimeoutError,
  RacedRedirectError,
  ScrapeJobTimeoutError,
  SitemapError,
  TransportableError,
  UnknownError,
  UnsupportedSiteError,
} from "./error";
import type { ErrorCode, TransportableErrorClass } from "./error";
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
  PromptInjectionDetectedError,
  PaywalledContentError,
  JsonExtractionContentTooLargeError,
  UsOnlyUnavailableError,
  ReservedCapacityUnavailableError,
  ExchangeRefusedError,
} from "../scraper/scrapeURL/error";
import { z } from "zod";
import { service } from "../service";
import { jsonObjectSchema } from "./json-types";

/**
 * The service's own error classes. Reading a code that no class carries gives
 * a plain TransportableError.
 */
export const coreErrors: Array<TransportableErrorClass> = [
  ExchangeRefusedError,
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
  AgentIndexOnlyError,
  RacedRedirectError,
  SitemapError,
  CrawlDenialError,
  UnsupportedSiteError,
  PromptInjectionDetectedError,
  PaywalledContentError,
  JsonExtractionContentTooLargeError,
  UsOnlyUnavailableError,
  ReservedCapacityUnavailableError,
  MapFailedError,
  ConcurrencyQueueTimeoutError,
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

// A code has no whitespace in it.
const CODE = /^\S+$/;

// ErrorCodes is open via declaration merging and rolling builds may emit
// unregistered codes, so any non-whitespace wire token revives as a plain
// TransportableError when no registered class claims it.
const wireErrorCodeSchema = z.custom<ErrorCode>(
  value => typeof value === "string" && CODE.test(value),
);

const plainErrorPayloadSchema = z.object({
  message: z.string(),
  stack: z.unknown().optional(),
  cause: z.unknown().optional(),
});

// What the queue keeps whole and every reader takes, whether or not it has
// a class for the code.
function crosses(serialized: string): boolean {
  if (Buffer.byteLength(serialized, "utf8") > MAX_SERIALIZED_ERROR_BYTES) {
    return false;
  }
  const written = parseSerializedError(serialized);
  return (
    written !== null &&
    CODE.test(written.code) &&
    typeof written.payload.message === "string"
  );
}

// What serializeThrownError returns for a value that can be read. Reading a
// thrown value can itself throw, and then this throws.
function serializeWithinLimit(error: unknown) {
  const thrown = isTransportableError(error) ? error : new UnknownError(error);

  try {
    let payload = thrown.serialize();
    const write = (fields: unknown) =>
      `${thrown.code}|${JSON.stringify(fields)}`;

    let serialized: string;
    try {
      serialized = write(payload);
    } catch {
      // The cause takes any value, and JSON cannot write every value, such as
      // an object that refers to itself.
      payload = { ...payload, cause: undefined };
      serialized = write(payload);
    }
    if (crosses(serialized)) {
      return serialized;
    }

    const stack = payload.stack && shortened(payload.stack);
    const message = shortened(payload.message);
    for (const shorter of [
      { ...payload, stack },
      { ...payload, stack, message },
      { ...payload, stack, message, cause: undefined },
      {
        ...Object.fromEntries(
          Object.entries(payload).map(([field, value]) => [
            field,
            typeof value === "string" ? shortened(value) : value,
          ]),
        ),
        cause: undefined,
      },
    ]) {
      serialized = write(shorter);
      if (crosses(serialized)) {
        return serialized;
      }
    }
  } catch {
    // `serialize()` threw, or what it returned cannot be written.
  }

  // This always fits: it holds two shortened texts and a fixed sentence, and a
  // character takes six bytes at most when it is written as JSON.
  const inner = new Error(shortened(String(thrown.message)));
  inner.stack = thrown.stack && shortened(String(thrown.stack));
  return serializeTransportableError(new UnknownError(inner));
}

/**
 * The wire form of anything a job throws. What is not a transportable error
 * goes out as UNKNOWN_ERROR. This never throws. What it returns fits the queue
 * and is what every reader parses as a serialized error: a code, then a JSON
 * object with a message. Reading back the fields that a class adds is up to
 * that class.
 *
 * An error crosses with its code even when it cannot be written as it is. A
 * cause that JSON cannot write is left out. An error that is too long for the
 * queue to keep whole gets its stack shortened, then its message, then loses
 * its cause, and then gets every other text it carries shortened, until it
 * fits.
 *
 * An error that still does not fit, or that does not write itself as a reader
 * takes it, goes out as UNKNOWN_ERROR with its message and its stack. A value
 * that cannot be read at all goes out as UNKNOWN_ERROR with a fixed message.
 */
export function serializeThrownError(error: unknown) {
  try {
    return serializeWithinLimit(error);
  } catch {
    // Reading the thrown value threw, as it does for an object that cannot be
    // made into a string.
    return serializeTransportableError(
      new UnknownError("The thrown value could not be read"),
    );
  }
}

/**
 * Splits a serialized error into its code and the object written after it.
 * Returns null for a string that is not written that way.
 */
function parseSerializedError(data: string) {
  const [code, ...serialized] = data.split("|");
  if (serialized.length === 0) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized.join("|"));
  } catch {
    return null;
  }
  const parsed = jsonObjectSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return { code, payload: parsed.data };
}

/**
 * Returns null when `data` is not a serialized error; callers also pass plain
 * error messages. A code that no registered class carries gives a plain
 * TransportableError.
 */
export function deserializeTransportableError(
  data: string,
): TransportableError | null {
  const parsed = parseSerializedError(data);
  if (parsed === null) {
    return null;
  }
  const { code, payload } = parsed;

  const errorClass = service.errors.classFor(code);
  if (errorClass) {
    const registeredCode = errorClass.codes.find(c => c === code);
    if (registeredCode !== undefined) {
      return errorClass.deserialize(registeredCode, payload);
    }
  }

  const wireCode = wireErrorCodeSchema.safeParse(code);
  const plainPayload = plainErrorPayloadSchema.safeParse(payload);
  if (!wireCode.success || !plainPayload.success) {
    return null;
  }
  return TransportableError.deserialize(wireCode.data, {
    message: plainPayload.data.message,
    stack:
      typeof plainPayload.data.stack === "string"
        ? plainPayload.data.stack
        : undefined,
    cause: plainPayload.data.cause,
  });
}
