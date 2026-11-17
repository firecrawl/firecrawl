import { describe, expect, it } from "vitest";
import { coreErrors } from "../lib/error-serde";
import { coreParts } from "./core-parts";
import { createService } from "./service";

describe("coreParts", () => {
  it("lists its error classes without loading them", () => {
    expect(coreParts().core.errors).toBeTypeOf("function");
  });

  it("gives the service every process role and error class, and nothing else yet", () => {
    // A test runner cannot load a module on first use, so the classes that
    // coreParts() would load are listed here.
    const parts = coreParts();
    const built = createService(
      { modules: {} },
      { ...parts, core: { ...parts.core, errors: coreErrors } },
    );

    expect(built.describe()).toEqual({
      extensions: ["core"],
      modules: [],
      hooks: {},
      errors: {
        AGENT_INDEX_ONLY: "core",
        CONCURRENCY_QUEUE_TIMEOUT: "core",
        CRAWL_DENIAL: "core",
        MAP_FAILED: "core",
        MAP_TIMEOUT: "core",
        RESERVED_CAPACITY_UNAVAILABLE: "core",
        SCRAPE_ACTIONS_NOT_SUPPORTED: "core",
        SCRAPE_ACTION_ERROR: "core",
        SCRAPE_ALL_ENGINES_FAILED: "core",
        SCRAPE_AUDIO_UNSUPPORTED_URL: "core",
        SCRAPE_BRANDING_NOT_SUPPORTED: "core",
        SCRAPE_DNS_RESOLUTION_ERROR: "core",
        SCRAPE_DOCUMENT_ANTIBOT_ERROR: "core",
        SCRAPE_DOCUMENT_FETCH_PROXY_ERROR: "core",
        SCRAPE_DOCUMENT_PREFETCH_FAILED: "core",
        SCRAPE_JOB_CANCELLED: "core",
        SCRAPE_JSON_CONTENT_TOO_LARGE: "core",
        SCRAPE_LOCKDOWN_CACHE_MISS: "core",
        SCRAPE_MEDIA_ACCESS_DENIED: "core",
        SCRAPE_NO_CACHED_DATA: "core",
        SCRAPE_PAYWALLED_CONTENT: "core",
        SCRAPE_PDF_ANTIBOT_ERROR: "core",
        SCRAPE_PDF_FETCH_PROXY_ERROR: "core",
        SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: "core",
        SCRAPE_PDF_OCR_REQUIRED: "core",
        SCRAPE_PDF_PREFETCH_FAILED: "core",
        SCRAPE_PROMPT_INJECTION_DETECTED: "core",
        SCRAPE_PROXY_SELECTION_ERROR: "core",
        SCRAPE_RACED_REDIRECT_ERROR: "core",
        SCRAPE_RETRY_LIMIT: "core",
        SCRAPE_SITEMAP_ERROR: "core",
        SCRAPE_SITE_ERROR: "core",
        SCRAPE_SITE_RESTRICTION_BLOCKED: "core",
        SCRAPE_SSL_ERROR: "core",
        SCRAPE_TIMEOUT: "core",
        SCRAPE_UNSUPPORTED_FILE_ERROR: "core",
        SCRAPE_VIDEO_UNSUPPORTED_URL: "core",
        SCRAPE_ZDR_VIOLATION_ERROR: "core",
        THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED: "core",
        THIRD_PARTY_DATA_NOT_ENABLED: "core",
        THIRD_PARTY_DATA_NOT_FOUND: "core",
        THIRD_PARTY_DATA_TERMS_REQUIRED: "core",
        THIRD_PARTY_DATA_UNSUPPORTED_OPTION: "core",
        THIRD_PARTY_DATA_UNSUPPORTED_URL: "core",
        UNKNOWN_ERROR: "core",
        UNSUPPORTED_SITE: "core",
        US_ONLY_UNAVAILABLE: "core",
        unsafe_domain_blocked: "core",
      },
      roles: {
        api: "core",
        "cclog-worker": "core",
        "extract-worker": "core",
        harness: "core",
        "index-worker": "core",
        "nuq-fdb-worker": "core",
        "nuq-prefetch-worker": "core",
        "nuq-reconciler-worker": "core",
        "nuq-worker": "core",
        "queue-worker": "core",
        "zdr-worker": "core",
      },
    });
  });
});
