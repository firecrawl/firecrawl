import { describe, expect, it } from "vitest";
import { decodeCoreNativeError } from "../native-errors";
import {
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  UnsupportedFileError,
} from "../../scraper/scrapeURL/error";

describe("decodeCoreNativeError", () => {
  it("maps SCRAPE_UNSUPPORTED_FILE_ERROR onto UnsupportedFileError", () => {
    const payload = {
      code: "SCRAPE_UNSUPPORTED_FILE_ERROR",
      reason: "archive not supported",
    };
    const decoded = decodeCoreNativeError(
      new Error(`${payload.code}|${JSON.stringify(payload)}`),
    );

    expect(decoded).not.toBeNull();
    expect(decoded?.failure).toEqual(payload);
    expect(decoded?.error).toBeInstanceOf(UnsupportedFileError);
    expect((decoded?.error as UnsupportedFileError).reason).toBe(
      "archive not supported",
    );
  });

  it("maps SCRAPE_PDF_OCR_REQUIRED onto PDFOCRRequiredError", () => {
    for (const pdfType of ["TextBased", "Scanned", "ImageBased", "Mixed"]) {
      const payload = { code: "SCRAPE_PDF_OCR_REQUIRED", pdfType };
      const decoded = decodeCoreNativeError(
        `${payload.code}|${JSON.stringify(payload)}`,
      );

      expect(decoded).not.toBeNull();
      expect(decoded?.failure).toEqual(payload);
      expect(decoded?.error).toBeInstanceOf(PDFOCRRequiredError);
      expect((decoded?.error as PDFOCRRequiredError).pdfType).toBe(pdfType);
    }
  });

  it("maps SCRAPE_PDF_INSUFFICIENT_TIME_ERROR onto PDFInsufficientTimeError", () => {
    const payload = {
      code: "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
      pageCount: 24,
      minTimeout: 12000,
    };
    const decoded = decodeCoreNativeError({
      message: `${payload.code}|${JSON.stringify(payload)}`,
    });

    expect(decoded).not.toBeNull();
    expect(decoded?.failure).toEqual(payload);
    expect(decoded?.error).toBeInstanceOf(PDFInsufficientTimeError);
    expect((decoded?.error as PDFInsufficientTimeError).pageCount).toBe(24);
    expect((decoded?.error as PDFInsufficientTimeError).minTimeout).toBe(12000);
  });

  it("decodes runtime native error codes into structured Error instances", () => {
    const cases = [
      {
        code: "NATIVE_INVALID_INPUT",
        argument: "request",
        path: "url",
        message: "missing field",
      },
      {
        code: "NATIVE_HTML_PROCESSING_ERROR",
        message: "invalid url",
      },
      {
        code: "NATIVE_DOCUMENT_PARSE_ERROR",
        parser: "pdf",
        message: "corrupt xref",
      },
      {
        code: "NATIVE_PANIC",
        message: "panic payload withheld (zero data retention)",
      },
      {
        code: "NATIVE_INTERNAL_ERROR",
        message: "worker channel closed",
      },
    ] as const;

    for (const payload of cases) {
      const source = new Error(`${payload.code}|${JSON.stringify(payload)}`);
      const decoded = decodeCoreNativeError(source);

      expect(decoded).not.toBeNull();
      expect(decoded?.failure).toEqual(payload);
      expect(decoded?.error).toBeInstanceOf(Error);
      expect(decoded?.error.name).toBe("CoreNativeRuntimeError");
      expect(decoded?.error.cause).toBe(source);
    }
  });

  it("returns null for non-native, malformed, or mismatched payloads", () => {
    const invalidInputs: unknown[] = [
      null,
      undefined,
      42,
      {},
      new Error("plain error without separator"),
      "|{}",
      "NATIVE_PANIC|not-json",
      "NATIVE_PANIC|[]",
      "NATIVE_PANIC|null",
      `SCRAPE_PDF_OCR_REQUIRED|${JSON.stringify({ code: "NATIVE_PANIC", message: "mismatch" })}`,
      `SCRAPE_PDF_OCR_REQUIRED|${JSON.stringify({ code: "SCRAPE_PDF_OCR_REQUIRED", pdfType: "Unknown" })}`,
      `SCRAPE_PDF_INSUFFICIENT_TIME_ERROR|${JSON.stringify({ code: "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR", pageCount: -1, minTimeout: 1000 })}`,
      `SCRAPE_PDF_INSUFFICIENT_TIME_ERROR|${JSON.stringify({ code: "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR", pageCount: 1.5, minTimeout: 1000 })}`,
      `NATIVE_DOCUMENT_PARSE_ERROR|${JSON.stringify({ code: "NATIVE_DOCUMENT_PARSE_ERROR", parser: "unknown", message: "bad" })}`,
      `NATIVE_INVALID_INPUT|${JSON.stringify({ code: "NATIVE_INVALID_INPUT", argument: "request" })}`,
      `UNKNOWN_CODE|${JSON.stringify({ code: "UNKNOWN_CODE", message: "nope" })}`,
    ];

    for (const input of invalidInputs) {
      expect(decodeCoreNativeError(input)).toBeNull();
    }
  });
});
