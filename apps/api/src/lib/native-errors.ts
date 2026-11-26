import type { CoreNative } from "@mendable/firecrawl-rs";
import {
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  UnsupportedFileError,
} from "../scraper/scrapeURL/error";

const CORE_PDF_TYPES: ReadonlySet<CoreNative.CorePdfType> = new Set([
  "TextBased",
  "Scanned",
  "ImageBased",
  "Mixed",
]);

const CORE_PARSER_KINDS: ReadonlySet<CoreNative.CoreParserKind> = new Set([
  "pdf",
  "document",
  "fallback",
  "rawBase64",
]);

function isCorePdfType(value: unknown): value is CoreNative.CorePdfType {
  return (
    typeof value === "string" &&
    CORE_PDF_TYPES.has(value as CoreNative.CorePdfType)
  );
}

function isCoreParserKind(value: unknown): value is CoreNative.CoreParserKind {
  return (
    typeof value === "string" &&
    CORE_PARSER_KINDS.has(value as CoreNative.CoreParserKind)
  );
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function extractMessage(err: unknown): string | null {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return null;
}

function formatNativeFailureMessage(
  failure: CoreNative.CoreNativeFailure,
): string {
  switch (failure.code) {
    case "NATIVE_INVALID_INPUT":
      return `Invalid native input for \`${failure.argument}\` at \`${failure.path}\`: ${failure.message}`;
    case "SCRAPE_UNSUPPORTED_FILE_ERROR":
      return `Unsupported file: ${failure.reason}`;
    case "SCRAPE_PDF_OCR_REQUIRED":
      return `PDF (${failure.pdfType}) requires OCR`;
    case "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR":
      return `PDF (${failure.pageCount} pages) requires at least ${failure.minTimeout}ms`;
    case "NATIVE_HTML_PROCESSING_ERROR":
      return `HTML processing failed: ${failure.message}`;
    case "NATIVE_DOCUMENT_PARSE_ERROR":
      return `${failure.parser} parser failed: ${failure.message}`;
    case "NATIVE_PANIC":
      return `Native task panicked: ${failure.message}`;
    case "NATIVE_INTERNAL_ERROR":
      return `Native internal error: ${failure.message}`;
  }
}

/**
 * Typed error representing a native failure that does not map onto an existing
 * scrape transport error class.
 */
class CoreNativeRuntimeError extends Error {
  public readonly failure: CoreNative.CoreNativeFailure;
  public readonly code: CoreNative.CoreNativeErrorCode;

  constructor(failure: CoreNative.CoreNativeFailure, cause?: unknown) {
    super(formatNativeFailureMessage(failure), { cause });
    this.name = "CoreNativeRuntimeError";
    this.failure = failure;
    this.code = failure.code;
  }
}

export interface DecodedCoreNativeError {
  failure: CoreNative.CoreNativeFailure;
  error: Error;
}

function parseCoreNativeFailure(
  err: unknown,
): CoreNative.CoreNativeFailure | null {
  const message = extractMessage(err);
  if (!message) {
    return null;
  }

  const sep = message.indexOf("|");
  if (sep <= 0) {
    return null;
  }

  const code = message.slice(0, sep);
  const rawPayload = message.slice(sep + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.code !== code) {
    return null;
  }

  switch (code) {
    case "NATIVE_INVALID_INPUT":
      if (
        typeof record.argument === "string" &&
        typeof record.path === "string" &&
        typeof record.message === "string"
      ) {
        return {
          code,
          argument: record.argument,
          path: record.path,
          message: record.message,
        };
      }
      return null;

    case "SCRAPE_UNSUPPORTED_FILE_ERROR":
      if (typeof record.reason === "string") {
        return { code, reason: record.reason };
      }
      return null;

    case "SCRAPE_PDF_OCR_REQUIRED":
      if (isCorePdfType(record.pdfType)) {
        return { code, pdfType: record.pdfType };
      }
      return null;

    case "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR":
      if (
        isNonNegativeInt(record.pageCount) &&
        isNonNegativeInt(record.minTimeout)
      ) {
        return {
          code,
          pageCount: record.pageCount,
          minTimeout: record.minTimeout,
        };
      }
      return null;

    case "NATIVE_HTML_PROCESSING_ERROR":
      if (typeof record.message === "string") {
        return { code, message: record.message };
      }
      return null;

    case "NATIVE_DOCUMENT_PARSE_ERROR":
      if (
        isCoreParserKind(record.parser) &&
        typeof record.message === "string"
      ) {
        return { code, parser: record.parser, message: record.message };
      }
      return null;

    case "NATIVE_PANIC":
      if (typeof record.message === "string") {
        return { code, message: record.message };
      }
      return null;

    case "NATIVE_INTERNAL_ERROR":
      if (typeof record.message === "string") {
        return { code, message: record.message };
      }
      return null;

    default:
      return null;
  }
}

/**
 * Decodes a `CODE|{json}` native error into its structured failure payload and
 * maps known scrape error codes onto existing Firecrawl error classes.
 */
export function decodeCoreNativeError(
  err: unknown,
): DecodedCoreNativeError | null {
  const failure = parseCoreNativeFailure(err);
  if (!failure) {
    return null;
  }

  let error: Error;
  switch (failure.code) {
    case "SCRAPE_UNSUPPORTED_FILE_ERROR":
      error = new UnsupportedFileError(failure.reason);
      break;
    case "SCRAPE_PDF_OCR_REQUIRED":
      error = new PDFOCRRequiredError(failure.pdfType);
      break;
    case "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR":
      error = new PDFInsufficientTimeError(
        failure.pageCount,
        failure.minTimeout,
      );
      break;
    default:
      error = new CoreNativeRuntimeError(failure, err);
      break;
  }

  return { failure, error };
}
