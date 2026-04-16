import { getHttpStatusForErrorCode, ErrorCodes } from "../error";

describe("getHttpStatusForErrorCode", () => {
  // 408 - Timeout errors
  test.each([
    "SCRAPE_TIMEOUT",
    "MAP_TIMEOUT",
    "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
  ] as ErrorCodes[])("%s returns 408", code => {
    expect(getHttpStatusForErrorCode(code)).toBe(408);
  });

  // 400 - Bad request / client configuration errors
  test.each([
    "SCRAPE_ACTIONS_NOT_SUPPORTED",
    "SCRAPE_PROXY_SELECTION_ERROR",
    "SCRAPE_ZDR_VIOLATION_ERROR",
    "BAD_REQUEST_INVALID_JSON",
    "BAD_REQUEST",
  ] as ErrorCodes[])("%s returns 400", code => {
    expect(getHttpStatusForErrorCode(code)).toBe(400);
  });

  // 403 - Forbidden
  test("AGENT_INDEX_ONLY returns 403", () => {
    expect(getHttpStatusForErrorCode("AGENT_INDEX_ONLY")).toBe(403);
  });

  // 404 - Not found
  test("SCRAPE_NO_CACHED_DATA returns 404", () => {
    expect(getHttpStatusForErrorCode("SCRAPE_NO_CACHED_DATA")).toBe(404);
  });

  // 200 - Success with failure payload
  test("SCRAPE_DNS_RESOLUTION_ERROR returns 200", () => {
    expect(getHttpStatusForErrorCode("SCRAPE_DNS_RESOLUTION_ERROR")).toBe(200);
  });

  // 422 - Target-site failures (valid request, but target cannot be scraped)
  test.each([
    "SCRAPE_ALL_ENGINES_FAILED",
    "SCRAPE_SSL_ERROR",
    "SCRAPE_SITE_ERROR",
    "SCRAPE_ACTION_ERROR",
    "SCRAPE_UNSUPPORTED_FILE_ERROR",
    "SCRAPE_PDF_ANTIBOT_ERROR",
    "SCRAPE_PDF_OCR_REQUIRED",
    "SCRAPE_PDF_PREFETCH_FAILED",
    "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
    "SCRAPE_DOCUMENT_PREFETCH_FAILED",
    "SCRAPE_BRANDING_NOT_SUPPORTED",
    "SCRAPE_AUDIO_UNSUPPORTED_URL",
    "SCRAPE_RACED_REDIRECT_ERROR",
    "SCRAPE_JOB_CANCELLED",
    "SCRAPE_RETRY_LIMIT",
    "SCRAPE_SITEMAP_ERROR",
    "CRAWL_DENIAL",
    "MAP_FAILED",
  ] as ErrorCodes[])("%s returns 422 (not 500)", code => {
    expect(getHttpStatusForErrorCode(code)).toBe(422);
  });

  // 500 - True server errors
  test("UNKNOWN_ERROR returns 500", () => {
    expect(getHttpStatusForErrorCode("UNKNOWN_ERROR")).toBe(500);
  });

  // Regression: these specific codes previously returned 500 incorrectly
  test("SCRAPE_ALL_ENGINES_FAILED does not return 500", () => {
    expect(getHttpStatusForErrorCode("SCRAPE_ALL_ENGINES_FAILED")).not.toBe(
      500,
    );
  });

  test("SCRAPE_SSL_ERROR does not return 500", () => {
    expect(getHttpStatusForErrorCode("SCRAPE_SSL_ERROR")).not.toBe(500);
  });
});
