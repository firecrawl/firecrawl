import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ActionError,
  AgentIndexOnlyError,
  DNSResolutionError,
  DocumentAntibotError,
  DocumentFetchProxyError,
  DocumentPrefetchFailed,
  ExchangeRefusedError,
  JsonExtractionContentTooLargeError,
  LockdownMissError,
  NoCachedDataError,
  NoEnginesLeftError,
  PaywalledContentError,
  PDFAntibotError,
  PDFFetchProxyError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  PDFPrefetchFailed,
  PromptInjectionDetectedError,
  ProxySelectionError,
  ReservedCapacityUnavailableError,
  ScrapeJobCancelledError,
  ScrapeRetryLimitError,
  SiteError,
  SiteRestrictionError,
  SSLError,
  UnsupportedFileError,
  UsOnlyUnavailableError,
  ZDRViolationError,
} from "../scraper/scrapeURL/error";
import { createService, replaceService } from "../service/service";
import { DATA_CHUNK_BYTES } from "../services/worker/nuq-fdb/queue";
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
  UnknownError,
  UnsupportedSiteError,
} from "./error";
import {
  coreErrors,
  deserializeTransportableError,
  MAX_SERIALIZED_ERROR_BYTES,
  serializeThrownError,
  serializeTransportableError,
} from "./error-serde";

const wire = (code: string, payload: unknown) =>
  `${code}|${JSON.stringify(payload)}`;

// What is read back from a job is rebuilt by the class the service has for its
// code. A test runner cannot load a module on first use, so the service is
// given the classes that its own extension would load.
const withCoreErrors = createService(
  { modules: {} },
  { core: { name: "core", errors: coreErrors }, logger: { error: vi.fn() } },
);
beforeAll(() => {
  replaceService(withCoreErrors);
});
afterAll(() => {
  replaceService(undefined);
});

describe("deserializeTransportableError", () => {
  describe("a code with a class", () => {
    it("round-trips to its class with its fields", () => {
      const original = new CrawlDenialError("Blocked by robots.txt", {
        robotsBlockedUrl: "https://example.com/private",
      });
      const revived = deserializeTransportableError(
        serializeTransportableError(original),
      ) as CrawlDenialError;

      expect(revived).toBeInstanceOf(CrawlDenialError);
      expect(revived.code).toBe("CRAWL_DENIAL");
      expect(revived.message).toBe("Blocked by robots.txt");
      expect(revived.reason).toBe("Blocked by robots.txt");
      expect(revived.robotsBlockedUrl).toBe("https://example.com/private");
      expect(revived.stack).toBe(original.stack);
    });

    it("reads a payload written as code, separator, JSON", () => {
      const revived = deserializeTransportableError(
        'SCRAPE_TIMEOUT|{"stack":"Error: slow | very slow\\n    at worker","message":"slow | very slow"}',
      )!;

      expect(revived).toBeInstanceOf(ScrapeJobTimeoutError);
      expect(revived.code).toBe("SCRAPE_TIMEOUT");
      expect(revived.message).toBe("slow | very slow");
      expect(revived.stack).toBe("Error: slow | very slow\n    at worker");
    });
  });

  describe("a code with no class", () => {
    it("gives a plain error that keeps the code and the message", () => {
      const revived = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", {
          stack: "Error: Not known here\n    at worker",
          message: "Not known here",
          detail: { onlyTheOtherBuildReadsThis: true },
        }),
      )!;

      expect(revived).toBeInstanceOf(TransportableError);
      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(revived.message).toBe("Not known here");
      expect(revived.stack).toBe("Error: Not known here\n    at worker");
    });

    it("keeps a message that contains the separator", () => {
      const revived = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", { message: "a | b | c" }),
      )!;

      expect(revived.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(revived.message).toBe("a | b | c");
    });

    it("keeps the code and the message when serialized again", () => {
      const first = deserializeTransportableError(
        wire("SCRAPE_FROM_ANOTHER_BUILD", {
          stack: "Error: Not known here\n    at worker",
          message: "Not known here",
        }),
      )!;
      const second = deserializeTransportableError(
        serializeTransportableError(first),
      )!;

      expect(second.constructor).toBe(TransportableError);
      expect(second.code).toBe("SCRAPE_FROM_ANOTHER_BUILD");
      expect(second.message).toBe("Not known here");
      expect(second.stack).toBe("Error: Not known here\n    at worker");
    });

    it("treats a code that is listed without a class the same way", () => {
      const revived = deserializeTransportableError(
        wire("SAFE_MODE_BLOCKED", { message: "Blocked by Safe Mode" }),
      )!;

      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("SAFE_MODE_BLOCKED");
      expect(revived.message).toBe("Blocked by Safe Mode");
    });

    it("does not take an inherited object key for a class", () => {
      const revived = deserializeTransportableError(
        wire("constructor", { message: "Not a class" }),
      )!;

      expect(revived.constructor).toBe(TransportableError);
      expect(revived.code).toBe("constructor");
      expect(deserializeTransportableError("toString")).toBeNull();
    });
  });

  describe("a string that is not a serialized error", () => {
    it.each([
      ["a plain message", "Timed out"],
      ["a sentence", "Job raced out while waiting for it"],
      ["an empty string", ""],
      ["a separator with no JSON after it", "connection lost|retrying"],
      ["prose before a JSON object", 'request failed|{"message":"nope"}'],
      ["an empty code", '|{"message":"nope"}'],
      ["a payload with no message", 'SOME_CODE|{"detail":"nope"}'],
      ["a payload whose message is not a string", 'SOME_CODE|{"message":5}'],
      ["an array payload", 'SOME_CODE|["nope"]'],
      ["a string payload", 'SOME_CODE|"nope"'],
      ["a null payload", "SOME_CODE|null"],
      ["a truncated payload", 'SOME_CODE|{"message":"cut of'],
      ["a code with a class and no payload", "SCRAPE_TIMEOUT"],
      [
        "a code with a class and a payload that is not JSON",
        "UNKNOWN_ERROR|oops",
      ],
      [
        "a code with a class and a truncated payload",
        'SCRAPE_TIMEOUT|{"message":"cut of',
      ],
      ["a code with a class and a null payload", "SCRAPE_TIMEOUT|null"],
    ])("returns null for %s", (_name, data) => {
      expect(deserializeTransportableError(data)).toBeNull();
    });
  });
});

describe("serializeTransportableError", () => {
  it("writes the code, a separator, then the JSON of serialize()", () => {
    const original = new CrawlDenialError("denied");
    const serialized = serializeTransportableError(original);

    expect(serialized.startsWith("CRAWL_DENIAL|")).toBe(true);
    expect(JSON.parse(serialized.slice("CRAWL_DENIAL|".length))).toEqual({
      stack: original.stack,
      message: "denied",
      reason: "denied",
      robotsBlockedUrl: null,
    });
  });
});

describe("the wire form of every class", () => {
  const processing = {
    state: "processing_continues" as const,
    documentPages: 700,
    jobStatus: "running" as const,
    estimatedRemainingSeconds: 840,
    retryAfterSeconds: 600,
    mayExceedProcessingWindow: true,
  };
  const stats = {
    totalAttempts: 9,
    addFeatureAttempts: 3,
    removeFeatureAttempts: 2,
    pdfAntibotAttempts: 1,
    documentAntibotAttempts: 1,
    pdfFetchProxyAttempts: 1,
    documentFetchProxyAttempts: 1,
  };
  // The code, a label, the error, and the fields its class writes after the
  // three every error has, in the order it writes them.
  const samples: [
    ErrorCode,
    string,
    () => TransportableError,
    Record<string, unknown>,
  ][] = [
    [
      "SCRAPE_TIMEOUT",
      "ScrapeJobTimeoutError",
      () =>
        new ScrapeJobTimeoutError(
          "Scrape timed out after waiting in the concurrency limit queue",
        ),
      {},
    ],
    [
      "SCRAPE_TIMEOUT",
      "ScrapeJobTimeoutError with processing details",
      () =>
        new ScrapeJobTimeoutError(
          "Request timed out, but this 700-page PDF is still being processed on our side.",
          processing,
        ),
      { processing },
    ],
    [
      "CONCURRENCY_QUEUE_TIMEOUT",
      "ConcurrencyQueueTimeoutError",
      () => new ConcurrencyQueueTimeoutError(),
      {},
    ],
    [
      "UNKNOWN_ERROR",
      "UnknownError from an Error",
      () => new UnknownError(new Error('boom | with a separator and "quotes"')),
      {},
    ],
    [
      "UNKNOWN_ERROR",
      "UnknownError from a string",
      () => new UnknownError("a thrown string"),
      {},
    ],
    ["MAP_TIMEOUT", "MapTimeoutError", () => new MapTimeoutError(), {}],
    [
      "MAP_FAILED",
      "MapFailedError",
      () => new MapFailedError("Map failed: the site returned no links"),
      {},
    ],
    [
      "SCRAPE_RACED_REDIRECT_ERROR",
      "RacedRedirectError",
      () => new RacedRedirectError(),
      {},
    ],
    [
      "SCRAPE_SITEMAP_ERROR",
      "SitemapError without a cause",
      () => new SitemapError("Sitemap fetch failed"),
      {},
    ],
    [
      "SCRAPE_SITEMAP_ERROR",
      "SitemapError with a plain cause",
      () =>
        new SitemapError("Sitemap fetch failed", {
          status: 503,
          body: "busy | later",
        }),
      {},
    ],
    [
      "SCRAPE_SITEMAP_ERROR",
      "SitemapError with an Error cause",
      () =>
        new SitemapError("Sitemap fetch failed", new Error("socket hang up")),
      {},
    ],
    [
      "CRAWL_DENIAL",
      "CrawlDenialError",
      () => new CrawlDenialError("URL is excluded by the crawl's excludePaths"),
      {
        reason: "URL is excluded by the crawl's excludePaths",
        robotsBlockedUrl: null,
      },
    ],
    [
      "CRAWL_DENIAL",
      "CrawlDenialError with a robots URL",
      () =>
        new CrawlDenialError("Blocked by robots.txt", {
          robotsBlockedUrl: "https://example.com/private",
        }),
      {
        reason: "Blocked by robots.txt",
        robotsBlockedUrl: "https://example.com/private",
      },
    ],
    [
      "UNSUPPORTED_SITE",
      "UnsupportedSiteError",
      () => new UnsupportedSiteError(),
      {},
    ],
    [
      "SCRAPE_ACTIONS_NOT_SUPPORTED",
      "ActionsNotSupportedError",
      () =>
        new ActionsNotSupportedError(
          "Actions are not supported by the selected engine",
        ),
      {},
    ],
    [
      "US_ONLY_UNAVAILABLE",
      "UsOnlyUnavailableError",
      () => new UsOnlyUnavailableError("No US-based route serves this request"),
      {},
    ],
    [
      "RESERVED_CAPACITY_UNAVAILABLE",
      "ReservedCapacityUnavailableError",
      () => new ReservedCapacityUnavailableError(),
      {},
    ],
    [
      "SCRAPE_ALL_ENGINES_FAILED",
      "NoEnginesLeftError",
      () => new NoEnginesLeftError(["fetch", "playwright"]),
      { fallbackList: ["fetch", "playwright"] },
    ],
    [
      "SCRAPE_SSL_ERROR",
      "SSLError",
      () => new SSLError(false),
      { skipTlsVerification: false, zeroDataRetention: false },
    ],
    [
      "SCRAPE_SSL_ERROR",
      "SSLError with both flags",
      () => new SSLError(true, true),
      { skipTlsVerification: true, zeroDataRetention: true },
    ],
    [
      "THIRD_PARTY_DATA_NOT_FOUND",
      "ExchangeRefusedError",
      () =>
        new ExchangeRefusedError(
          "THIRD_PARTY_DATA_NOT_FOUND",
          "The provider holds no record for this URL",
        ),
      {},
    ],
    [
      "THIRD_PARTY_DATA_UNSUPPORTED_URL",
      "ExchangeRefusedError",
      () =>
        new ExchangeRefusedError(
          "THIRD_PARTY_DATA_UNSUPPORTED_URL",
          "The provider does not serve this URL",
        ),
      {},
    ],
    [
      "THIRD_PARTY_DATA_NOT_ENABLED",
      "ExchangeRefusedError",
      () =>
        new ExchangeRefusedError(
          "THIRD_PARTY_DATA_NOT_ENABLED",
          "The provider is not enabled",
        ),
      {},
    ],
    [
      "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
      "ExchangeRefusedError",
      () =>
        new ExchangeRefusedError(
          "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
          "Enrichment is not enabled",
        ),
      {},
    ],
    [
      "SCRAPE_SITE_ERROR",
      "SiteError",
      () => new SiteError("ERR_CONNECTION_RESET"),
      { errorCode: "ERR_CONNECTION_RESET" },
    ],
    [
      "SCRAPE_PROXY_SELECTION_ERROR",
      "ProxySelectionError",
      () => new ProxySelectionError(),
      {},
    ],
    [
      "SCRAPE_SITE_RESTRICTION_BLOCKED",
      "SiteRestrictionError",
      () => new SiteRestrictionError(),
      {},
    ],
    [
      "SCRAPE_ACTION_ERROR",
      "ActionError",
      () => new ActionError("Element not found: #submit"),
      { errorCode: "Element not found: #submit" },
    ],
    [
      "SCRAPE_UNSUPPORTED_FILE_ERROR",
      "UnsupportedFileError",
      () => new UnsupportedFileError("application/zip"),
      { reason: "application/zip" },
    ],
    [
      "SCRAPE_PDF_ANTIBOT_ERROR",
      "PDFAntibotError",
      () => new PDFAntibotError(),
      {},
    ],
    [
      "SCRAPE_PDF_FETCH_PROXY_ERROR",
      "PDFFetchProxyError",
      () => new PDFFetchProxyError(),
      {},
    ],
    [
      "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
      "PDFInsufficientTimeError",
      () => new PDFInsufficientTimeError(412, 95000),
      { pageCount: 412, minTimeout: 95000 },
    ],
    [
      "SCRAPE_DNS_RESOLUTION_ERROR",
      "DNSResolutionError",
      () => new DNSResolutionError("nowhere.example"),
      { hostname: "nowhere.example" },
    ],
    [
      "SCRAPE_NO_CACHED_DATA",
      "NoCachedDataError",
      () => new NoCachedDataError(),
      {},
    ],
    [
      "SCRAPE_LOCKDOWN_CACHE_MISS",
      "LockdownMissError",
      () => new LockdownMissError(),
      {},
    ],
    [
      "SCRAPE_ZDR_VIOLATION_ERROR",
      "ZDRViolationError",
      () => new ZDRViolationError("screenshot"),
      { feature: "screenshot" },
    ],
    [
      "SCRAPE_PDF_OCR_REQUIRED",
      "PDFOCRRequiredError",
      () => new PDFOCRRequiredError("scanned"),
      { pdfType: "scanned" },
    ],
    [
      "SCRAPE_PDF_PREFETCH_FAILED",
      "PDFPrefetchFailed",
      () => new PDFPrefetchFailed(),
      {},
    ],
    [
      "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
      "DocumentAntibotError",
      () => new DocumentAntibotError(),
      {},
    ],
    [
      "SCRAPE_DOCUMENT_FETCH_PROXY_ERROR",
      "DocumentFetchProxyError",
      () => new DocumentFetchProxyError(),
      {},
    ],
    [
      "SCRAPE_DOCUMENT_PREFETCH_FAILED",
      "DocumentPrefetchFailed",
      () => new DocumentPrefetchFailed(),
      {},
    ],
    [
      "AGENT_INDEX_ONLY",
      "AgentIndexOnlyError",
      () => new AgentIndexOnlyError(),
      {},
    ],
    [
      "SCRAPE_PROMPT_INJECTION_DETECTED",
      "PromptInjectionDetectedError",
      () => new PromptInjectionDetectedError(),
      {},
    ],
    [
      "SCRAPE_PAYWALLED_CONTENT",
      "PaywalledContentError",
      () => new PaywalledContentError(),
      {},
    ],
    [
      "SCRAPE_JSON_CONTENT_TOO_LARGE",
      "JsonExtractionContentTooLargeError",
      () => new JsonExtractionContentTooLargeError(),
      {},
    ],
    [
      "SCRAPE_JOB_CANCELLED",
      "ScrapeJobCancelledError",
      () => new ScrapeJobCancelledError(),
      {},
    ],
    [
      "SCRAPE_RETRY_LIMIT",
      "ScrapeRetryLimitError",
      () => new ScrapeRetryLimitError("feature_toggle", stats),
      { reason: "feature_toggle", stats },
    ],
  ];

  it.each(samples)("%s: %s", (code, _label, build, own) => {
    const original = build();
    const serialized = serializeTransportableError(original);

    expect(original.code).toBe(code);
    expect(serialized).toBe(
      wire(code, {
        cause: original.cause,
        stack: original.stack,
        message: original.message,
        ...own,
      }),
    );

    const revived = deserializeTransportableError(serialized)!;

    expect(revived.constructor).toBe(original.constructor);
    expect(revived.code).toBe(code);
    expect(revived.message).toBe(original.message);
    expect(serializeTransportableError(revived)).toBe(serialized);
  });

  it("has a sample for every registered class and every code it carries", () => {
    const built = samples.map(([, , build]) => build());

    expect(new Set(built.map(error => error.constructor))).toEqual(
      new Set(coreErrors),
    );
    expect(new Set(built.map(error => error.code))).toEqual(
      new Set(coreErrors.flatMap(errorClass => errorClass.codes)),
    );
  });
});

describe("serializeThrownError", () => {
  it("serializes a transportable error as itself", () => {
    const original = new CrawlDenialError("denied");

    expect(serializeThrownError(original)).toBe(
      serializeTransportableError(original),
    );
  });

  it("sends anything else as UNKNOWN_ERROR", () => {
    const inner = new Error("socket hang up");

    expect(serializeThrownError(inner)).toBe(
      serializeTransportableError(new UnknownError(inner)),
    );
    expect(serializeThrownError("a thrown string")).toMatch(/^UNKNOWN_ERROR\|/);
    expect(serializeThrownError(undefined)).toMatch(/^UNKNOWN_ERROR\|/);
  });

  it("does not take an error that only has a code for a transportable one", () => {
    const inner = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    expect(isTransportableError(inner)).toBe(false);
    expect(serializeThrownError(inner)).toMatch(/^UNKNOWN_ERROR\|/);
  });

  it("leaves out a cause that JSON cannot write", () => {
    const circular: Record<string, unknown> = { status: 503 };
    circular.self = circular;

    for (const cause of [circular, { bytes: 10n }]) {
      const original = new SitemapError("Sitemap fetch failed", cause);
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(() => serializeTransportableError(original)).toThrow(TypeError);
      expect(serialized).toBe(
        wire("SCRAPE_SITEMAP_ERROR", {
          stack: original.stack,
          message: "Sitemap fetch failed",
        }),
      );
      expect(revived).toBeInstanceOf(SitemapError);
      expect(revived.cause).toBeUndefined();
    }
  });

  it.each([
    [
      "throws when it writes itself",
      {
        serialize: () => {
          throw new Error("cannot serialize");
        },
      },
    ],
    [
      "writes a field that JSON cannot write",
      { serialize: () => ({ message: "Sitemap fetch failed", pages: 10n }) },
    ],
    ["writes nothing", { serialize: () => undefined }],
    [
      "writes something that is not an object",
      { serialize: () => "Sitemap fetch failed" },
    ],
    [
      "writes an object without a message",
      { serialize: () => ({ pages: 10 }) },
    ],
    ["has a code with a space in it", { code: "TWO WORDS" }],
    ["has an empty code", { code: "" }],
    ["has a code with the separator in it", { code: "A|B" }],
  ])(
    "sends an error that %s as UNKNOWN_ERROR with its message",
    (_, broken) => {
      const original = Object.assign(
        new SitemapError("Sitemap fetch failed"),
        broken,
      );
      const revived = deserializeTransportableError(
        serializeThrownError(original),
      )!;

      expect(revived).toBeInstanceOf(UnknownError);
      expect(revived.code).toBe("UNKNOWN_ERROR");
      expect(revived.message).toBe(
        new UnknownError(new Error("Sitemap fetch failed")).message,
      );
      expect(revived.stack).toBe(original.stack);
    },
  );

  it.each([
    ["cannot be made into a string", () => Object.create(null)],
    [
      "throws when its message is read",
      () =>
        Object.defineProperty(new Error("slow"), "message", {
          get() {
            throw new Error("cannot read");
          },
        }),
    ],
    [
      "throws when it is asked whether it is an error",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("cannot ask");
            },
          },
        ),
    ],
  ])("sends a thrown value that %s as UNKNOWN_ERROR", (_, build) => {
    const revived = deserializeTransportableError(
      serializeThrownError(build()),
    )!;

    expect(revived).toBeInstanceOf(UnknownError);
    expect(revived.code).toBe("UNKNOWN_ERROR");
    expect(revived.message).toBe(
      new UnknownError("The thrown value could not be read").message,
    );
  });

  describe("an error that is too long for the queue to keep whole", () => {
    const long = (length: number) => "x".repeat(length);
    const bytes = (text: string) => Buffer.byteLength(text, "utf8");
    const cut = (text: string) => `${text.slice(0, 4096)}... [truncated]`;

    it("is too long past what the FoundationDB queue keeps of a reason", () => {
      expect(MAX_SERIALIZED_ERROR_BYTES).toBe(DATA_CHUNK_BYTES);
    });

    it("is left as it is while it fits", () => {
      const original = new SitemapError(long(30_000));
      const serialized = serializeThrownError(original);

      expect(serialized).toBe(serializeTransportableError(original));
      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
    });

    it("gets its stack shortened first", () => {
      const original = new SitemapError(long(60_000));
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(bytes(serializeTransportableError(original))).toBeGreaterThan(
        MAX_SERIALIZED_ERROR_BYTES,
      );
      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived).toBeInstanceOf(SitemapError);
      expect(revived.message).toBe(original.message);
      expect(revived.stack).toBe(cut(original.stack!));
    });

    it("is measured in bytes, as the queue stores it", () => {
      const original = new SitemapError("é".repeat(30_000));
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(serializeTransportableError(original).length).toBeLessThan(
        MAX_SERIALIZED_ERROR_BYTES,
      );
      expect(bytes(serializeTransportableError(original))).toBeGreaterThan(
        MAX_SERIALIZED_ERROR_BYTES,
      );
      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived.message).toBe(original.message);
      expect(revived.stack).toBe(cut(original.stack!));
    });

    it("then gets its message shortened", () => {
      const original = new SitemapError(long(200_000), { status: 503 });
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived).toBeInstanceOf(SitemapError);
      expect(revived.message).toBe(cut(original.message));
      expect(revived.stack).toBe(cut(original.stack!));
      expect(revived.cause).toEqual({ status: 503 });
    });

    it("is not cut in the middle of a character", () => {
      const original = new SitemapError(
        `${long(4095)}\u{1F600}${long(200_000)}`,
      );
      const revived = deserializeTransportableError(
        serializeThrownError(original),
      )!;

      expect(revived.message).toBe(`${long(4095)}... [truncated]`);
    });

    it("then loses its cause", () => {
      const original = new SitemapError("Sitemap fetch failed", {
        body: long(200_000),
      });
      original.stack = "Error: Sitemap fetch failed\n    at fetchSitemap";
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(serialized).toBe(
        wire("SCRAPE_SITEMAP_ERROR", {
          stack: original.stack,
          message: "Sitemap fetch failed",
        }),
      );
      expect(revived).toBeInstanceOf(SitemapError);
      expect(revived.cause).toBeUndefined();
    });

    it("then gets every other text it carries shortened", () => {
      const original = new CrawlDenialError(long(200_000), {
        robotsBlockedUrl: "https://example.com/private",
      });
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(
        serialized,
      ) as CrawlDenialError;

      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived).toBeInstanceOf(CrawlDenialError);
      expect(revived.code).toBe("CRAWL_DENIAL");
      expect(revived.reason).toBe(cut(original.reason));
      expect(revived.robotsBlockedUrl).toBe("https://example.com/private");
      expect(revived.stack).toBe(cut(original.stack!));
    });

    it("goes out as UNKNOWN_ERROR with its message when it still does not fit", () => {
      const original = new NoEnginesLeftError(
        Array.from({ length: 20_000 }, () => "fetch" as const),
      );
      const serialized = serializeThrownError(original);
      const revived = deserializeTransportableError(serialized)!;

      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived).toBeInstanceOf(UnknownError);
      expect(revived.code).toBe("UNKNOWN_ERROR");
      expect(revived.message).toBe(
        new UnknownError(new Error(cut(original.message))).message,
      );
      expect(revived.stack).toBe(cut(original.stack!));
    });

    it("fits whatever characters its texts hold", () => {
      // A control character takes six bytes when it is written as JSON.
      const original = Object.assign(
        new SitemapError("\u0001".repeat(200_000)),
        {
          serialize: () => {
            throw new Error("cannot serialize");
          },
        },
      );
      const serialized = serializeThrownError(original);

      expect(serialized).toMatch(/^UNKNOWN_ERROR\|/);
      expect(bytes(serialized)).toBeGreaterThan(40_000);
      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(deserializeTransportableError(serialized)).toBeInstanceOf(
        UnknownError,
      );
    });

    it("keeps UNKNOWN_ERROR readable for an error with a very long message", () => {
      const inner = new Error(long(200_000));
      const serialized = serializeThrownError(inner);
      const revived = deserializeTransportableError(serialized)!;

      expect(bytes(serialized)).toBeLessThanOrEqual(MAX_SERIALIZED_ERROR_BYTES);
      expect(revived).toBeInstanceOf(UnknownError);
      expect(revived.code).toBe("UNKNOWN_ERROR");
      expect(revived.message).toBe(cut(new UnknownError(inner).message));
    });
  });

  it("keeps the code of an error built from a second copy of the base class", async () => {
    vi.resetModules();
    const second = await import("./error.js");
    const foreign = new second.CrawlDenialError("Blocked by robots.txt", {
      robotsBlockedUrl: "https://example.com/private",
    });

    expect(second.TransportableError).not.toBe(TransportableError);
    expect(foreign instanceof TransportableError).toBe(false);
    expect(isTransportableError(foreign)).toBe(true);

    const serialized = serializeThrownError(foreign);
    const revived = deserializeTransportableError(
      serialized,
    ) as CrawlDenialError;

    expect(serialized).toBe(serializeTransportableError(foreign));
    expect(serialized).toMatch(/^CRAWL_DENIAL\|/);
    expect(revived).toBeInstanceOf(CrawlDenialError);
    expect(revived.robotsBlockedUrl).toBe("https://example.com/private");
  });
});
