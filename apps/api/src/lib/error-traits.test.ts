import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ActionError,
  AddFeatureError,
  AgentIndexOnlyError,
  DNSResolutionError,
  DocumentAntibotError,
  DocumentFetchProxyError,
  EngineError,
  ExchangeRefusedError,
  FEPageLoadFailed,
  IndexMissError,
  LockdownMissError,
  NoCachedDataError,
  NoEnginesLeftError,
  PaywalledContentError,
  PDFAntibotError,
  PDFFetchProxyError,
  PDFInsufficientTimeError,
  PDFOCRRequiredError,
  ProxySelectionError,
  RemoveFeatureError,
  ReservedCapacityUnavailableError,
  SiteBlockNoRetryError,
  SiteError,
  SiteRestrictionError,
  SSLError,
  UnsupportedFileError,
  UsOnlyUnavailableError,
} from "../scraper/scrapeURL/error";
import { createService, replaceService } from "../service/service";
import {
  abortsEngineRace,
  endsEngineLoop,
  FormatUnavailableError,
  getErrorHttpResponse,
  getErrorScrapeLog,
  isFormatUnavailable,
  ScrapeJobTimeoutError,
  shouldPropagateFromExtraction,
  stopsCrawlRetry,
  TransportableError,
} from "./error";
import {
  coreErrors,
  deserializeTransportableError,
  serializeThrownError,
  serializeTransportableError,
} from "./error-serde";
import type { JsonObject } from "./json-types";

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

describe("behavioral error traits", () => {
  it("keeps the four behavioral traits distinct", () => {
    const usOnly = new UsOnlyUnavailableError("not available in US-only mode");
    const paywalled = new PaywalledContentError();
    const siteBlock = new SiteBlockNoRetryError("instant-block: login wall");

    expect({
      endsEngineLoop: endsEngineLoop(usOnly),
      abortsEngineRace: abortsEngineRace(usOnly),
      stopsCrawlRetry: stopsCrawlRetry(usOnly),
      propagateFromExtraction: shouldPropagateFromExtraction(usOnly),
    }).toEqual({
      endsEngineLoop: true,
      abortsEngineRace: false,
      stopsCrawlRetry: false,
      propagateFromExtraction: true,
    });

    expect({
      endsEngineLoop: endsEngineLoop(paywalled),
      abortsEngineRace: abortsEngineRace(paywalled),
      stopsCrawlRetry: stopsCrawlRetry(paywalled),
      propagateFromExtraction: shouldPropagateFromExtraction(paywalled),
    }).toEqual({
      endsEngineLoop: false,
      abortsEngineRace: false,
      stopsCrawlRetry: true,
      propagateFromExtraction: false,
    });

    expect({
      endsEngineLoop: endsEngineLoop(siteBlock),
      abortsEngineRace: abortsEngineRace(siteBlock),
      stopsCrawlRetry: stopsCrawlRetry(siteBlock),
      propagateFromExtraction: shouldPropagateFromExtraction(siteBlock),
    }).toEqual({
      endsEngineLoop: false,
      abortsEngineRace: true,
      stopsCrawlRetry: false,
      propagateFromExtraction: false,
    });
  });

  it("marks all 21 engine-loop-terminal errors and excludes non-terminal errors", () => {
    const terminalErrors: Array<Error> = [
      new AddFeatureError(["stealthProxy"]),
      new RemoveFeatureError(["pdf"]),
      new SiteError("ERR_CONNECTION_RESET"),
      new SiteRestrictionError(),
      new SSLError(false),
      new DNSResolutionError("nowhere.example"),
      new ActionError("timeout"),
      new UnsupportedFileError("application/zip"),
      new PDFAntibotError(),
      new PDFFetchProxyError(),
      new PDFOCRRequiredError("Scanned"),
      new DocumentAntibotError(),
      new DocumentFetchProxyError(),
      new PDFInsufficientTimeError(100, 60_000),
      new ProxySelectionError(),
      new NoCachedDataError(),
      new AgentIndexOnlyError(),
      new UsOnlyUnavailableError("us-only"),
      new ReservedCapacityUnavailableError(),
      new ExchangeRefusedError("THIRD_PARTY_DATA_NOT_FOUND", "missing"),
    ];

    for (const error of terminalErrors) {
      expect(endsEngineLoop(error), error.constructor.name).toBe(true);
    }

    const nonTerminalErrors: Array<Error> = [
      new EngineError("failed"),
      new IndexMissError(),
      new FEPageLoadFailed(),
      new SiteBlockNoRetryError("instant-block: wall"),
      new NoEnginesLeftError(["fetch"]),
      new LockdownMissError(),
      new PaywalledContentError(),
      new ScrapeJobTimeoutError(),
      new TransportableError("UNKNOWN_ERROR", "plain"),
      new Error("plain"),
    ];

    for (const error of nonTerminalErrors) {
      expect(endsEngineLoop(error), error.constructor.name).toBe(false);
    }
  });

  it("keeps unknown deserialized transportable errors free of behavioral and HTTP traits", () => {
    const bare = deserializeTransportableError(
      'UNREGISTERED_CODE|{"message":"from another build","stack":"fixed"}',
    )!;

    expect(bare.constructor).toBe(TransportableError);
    expect(endsEngineLoop(bare)).toBe(false);
    expect(abortsEngineRace(bare)).toBe(false);
    expect(stopsCrawlRetry(bare)).toBe(false);
    expect(shouldPropagateFromExtraction(bare)).toBe(false);
    expect(getErrorHttpResponse(bare)).toBeUndefined();
    expect(isFormatUnavailable(bare)).toBe(false);
  });
});

describe("HTTP response metadata", () => {
  it("derives exact HTTP status and extra fields for every mapped error class", () => {
    const cases: Array<{
      label: string;
      error: TransportableError;
      expected: {
        status: number;
        code: string;
        extraFields?: JsonObject;
      };
    }> = [
      {
        label: "ExchangeRefusedError THIRD_PARTY_DATA_NOT_ENABLED",
        error: new ExchangeRefusedError(
          "THIRD_PARTY_DATA_NOT_ENABLED",
          "not enabled",
        ),
        expected: { status: 403, code: "THIRD_PARTY_DATA_NOT_ENABLED" },
      },
      {
        label: "ExchangeRefusedError THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
        error: new ExchangeRefusedError(
          "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
          "enrichment disabled",
        ),
        expected: {
          status: 403,
          code: "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
        },
      },
      {
        label: "ExchangeRefusedError THIRD_PARTY_DATA_NOT_FOUND",
        error: new ExchangeRefusedError(
          "THIRD_PARTY_DATA_NOT_FOUND",
          "not found",
        ),
        expected: { status: 404, code: "THIRD_PARTY_DATA_NOT_FOUND" },
      },
      {
        label: "ExchangeRefusedError THIRD_PARTY_DATA_UNSUPPORTED_URL",
        error: new ExchangeRefusedError(
          "THIRD_PARTY_DATA_UNSUPPORTED_URL",
          "unsupported url",
        ),
        expected: { status: 400, code: "THIRD_PARTY_DATA_UNSUPPORTED_URL" },
      },
      {
        label: "AgentIndexOnlyError",
        error: new AgentIndexOnlyError(),
        expected: {
          status: 403,
          code: "AGENT_INDEX_ONLY",
          extraFields: {
            sponsor_status: "pending",
            login_url: "https://firecrawl.dev/signin",
          },
        },
      },
      {
        label: "NoCachedDataError",
        error: new NoCachedDataError(),
        expected: { status: 404, code: "SCRAPE_NO_CACHED_DATA" },
      },
      {
        label: "LockdownMissError",
        error: new LockdownMissError(),
        expected: { status: 404, code: "SCRAPE_LOCKDOWN_CACHE_MISS" },
      },
      {
        label: "UsOnlyUnavailableError",
        error: new UsOnlyUnavailableError("us-only refusal"),
        expected: { status: 403, code: "US_ONLY_UNAVAILABLE" },
      },
      {
        label: "ReservedCapacityUnavailableError",
        error: new ReservedCapacityUnavailableError(),
        expected: { status: 403, code: "RESERVED_CAPACITY_UNAVAILABLE" },
      },
      {
        label: "PaywalledContentError",
        error: new PaywalledContentError(),
        expected: { status: 403, code: "SCRAPE_PAYWALLED_CONTENT" },
      },
    ];

    interface ExpectedErrorHttpResponse {
      status: number;
      code: string;
      message: string;
      extraFields?: JsonObject;
    }

    for (const { label, error, expected } of cases) {
      const response = getErrorHttpResponse(error);
      const expectedResponse: ExpectedErrorHttpResponse = {
        status: expected.status,
        code: expected.code,
        message: error.message,
      };
      if (expected.extraFields) {
        expectedResponse.extraFields = expected.extraFields;
      }
      expect(response, label).toEqual(expectedResponse);

      const revived = deserializeTransportableError(
        serializeTransportableError(error),
      )!;
      expect(
        getErrorHttpResponse(revived),
        `${label} after round-trip`,
      ).toEqual(response);
    }
  });

  it("supports non-transportable errors with httpStatus and rejects invalid statuses", () => {
    class CustomStatusError extends Error {
      constructor(
        readonly httpStatus: number,
        message: string,
        readonly code?: string,
      ) {
        super(message);
      }
    }

    expect(
      getErrorHttpResponse(
        new CustomStatusError(403, "refused", "US_ONLY_UNAVAILABLE"),
      ),
    ).toEqual({
      status: 403,
      code: "US_ONLY_UNAVAILABLE",
      message: "refused",
    });

    expect(
      getErrorHttpResponse(new CustomStatusError(502, "upstream failed")),
    ).toEqual({
      status: 502,
      message: "upstream failed",
    });

    expect(
      getErrorHttpResponse(new CustomStatusError(99, "too low")),
    ).toBeUndefined();
    expect(
      getErrorHttpResponse(new CustomStatusError(600, "too high")),
    ).toBeUndefined();
    expect(
      getErrorHttpResponse(new CustomStatusError(Number.NaN, "nan")),
    ).toBeUndefined();
    expect(getErrorHttpResponse(new ScrapeJobTimeoutError())).toBeUndefined();
    expect(
      getErrorHttpResponse(new NoEnginesLeftError(["fetch"])),
    ).toBeUndefined();
    expect(getErrorHttpResponse(new Error("plain"))).toBeUndefined();
    expect(
      getErrorHttpResponse({ httpStatus: 403, message: "not an error" }),
    ).toBeUndefined();
  });
});

describe("wire format stability", () => {
  it("serializes no behavioral or HTTP trait fields and round-trips byte-for-byte", () => {
    const modifiedErrors: Array<TransportableError> = [
      new SiteError("ERR_CONNECTION_RESET"),
      new SiteRestrictionError(),
      new SSLError(false),
      new DNSResolutionError("nowhere.example"),
      new ActionError("timeout"),
      new UnsupportedFileError("application/zip"),
      new PDFAntibotError(),
      new PDFFetchProxyError(),
      new PDFOCRRequiredError("Scanned"),
      new DocumentAntibotError(),
      new DocumentFetchProxyError(),
      new PDFInsufficientTimeError(100, 60_000),
      new ProxySelectionError(),
      new NoCachedDataError(),
      new LockdownMissError(),
      new AgentIndexOnlyError(),
      new UsOnlyUnavailableError("us-only"),
      new ReservedCapacityUnavailableError(),
      new ExchangeRefusedError("THIRD_PARTY_DATA_NOT_FOUND", "missing"),
      new ExchangeRefusedError("THIRD_PARTY_DATA_UNSUPPORTED_URL", "bad url"),
      new ExchangeRefusedError("THIRD_PARTY_DATA_NOT_ENABLED", "disabled"),
      new ExchangeRefusedError(
        "THIRD_PARTY_DATA_ENRICHMENT_NOT_ENABLED",
        "enrichment disabled",
      ),
      new PaywalledContentError(),
    ];

    const traitKeyPattern =
      /endsEngineLoop|abortsEngineRace|stopsCrawlRetry|propagateFromExtraction|httpStatus|httpResponseFields|scrapeLog/;

    for (const error of modifiedErrors) {
      error.stack = "fixed";
      const serialized = serializeTransportableError(error);
      expect(serialized, error.constructor.name).not.toMatch(traitKeyPattern);
      expect(serializeThrownError(error), error.constructor.name).toBe(
        serialized,
      );

      const revived = deserializeTransportableError(serialized)!;
      expect(revived.constructor, error.constructor.name).toBe(
        error.constructor,
      );
      expect(serializeTransportableError(revived), error.constructor.name).toBe(
        serialized,
      );
      expect(Object.getOwnPropertySymbols(error)).toEqual([]);
      for (const key of Object.keys(error)) {
        expect(key, `${error.constructor.name}.${key}`).not.toMatch(
          traitKeyPattern,
        );
      }
    }
  });
});

describe("EngineError inheritance", () => {
  it("makes IndexMissError and FEPageLoadFailed subclasses of EngineError with preserved log text", () => {
    const base = new EngineError("generic");
    const indexMiss = new IndexMissError();
    const fePageLoad = new FEPageLoadFailed();

    expect(indexMiss).toBeInstanceOf(EngineError);
    expect(fePageLoad).toBeInstanceOf(EngineError);

    expect(base.formatEngineLog("fetch")).toBe(
      "Engine fetch could not scrape the page.",
    );
    expect(indexMiss.formatEngineLog("index")).toBe(
      "Engine index could not find the page in the index.",
    );
    expect(fePageLoad.formatEngineLog("fire-engine;chrome-cdp")).toBe(
      "FEPageLoadFailed encountered",
    );
  });
});

describe("FormatUnavailableError and isFormatUnavailable", () => {
  it("matches concrete FormatUnavailableError subclasses with preserved warning text", () => {
    class StubFormatUnavailableError extends FormatUnavailableError {
      constructor(message: string) {
        super("custom", "UNKNOWN_ERROR", message);
      }
    }

    class CustomFormatError extends FormatUnavailableError {
      constructor(message: string) {
        super(
          "custom-format",
          "UNKNOWN_ERROR",
          message,
          `Custom format was skipped: ${message}`,
        );
      }
    }

    const custom = new StubFormatUnavailableError("Custom format unavailable");
    const customWithWarning = new CustomFormatError(
      "Format is only supported for HTML web pages.",
    );

    expect(isFormatUnavailable(custom)).toBe(true);
    expect(custom.format).toBe("custom");
    expect(custom.warning).toBe("Custom format unavailable");

    expect(customWithWarning).toBeInstanceOf(FormatUnavailableError);
    expect(isFormatUnavailable(customWithWarning)).toBe(true);
    expect(customWithWarning.format).toBe("custom-format");
    expect(customWithWarning.warning).toBe(
      "Custom format was skipped: Format is only supported for HTML web pages.",
    );

    expect(isFormatUnavailable(new NoCachedDataError())).toBe(false);
    expect(
      isFormatUnavailable(
        Object.assign(new Error("plain"), {
          format: "custom-format",
          warning: "warn",
        }),
      ),
    ).toBe(false);
    expect(
      isFormatUnavailable({ format: "custom-format", warning: "warn" }),
    ).toBe(false);
  });

  it("recognizes FormatUnavailableError and behavioral traits across module copies", async () => {
    vi.resetModules();
    const second = await import("./error.js");

    class ForeignFormatUnavailableError extends second.FormatUnavailableError {
      constructor(message: string) {
        super(
          "custom-format",
          "UNKNOWN_ERROR",
          message,
          `Custom format was skipped: ${message}`,
        );
      }
    }

    const foreignFormat = new ForeignFormatUnavailableError("Not supported");
    expect(second.FormatUnavailableError).not.toBe(FormatUnavailableError);
    expect(foreignFormat instanceof FormatUnavailableError).toBe(false);
    expect(isFormatUnavailable(foreignFormat)).toBe(true);
    if (isFormatUnavailable(foreignFormat)) {
      expect(foreignFormat.format).toBe("custom-format");
      expect(foreignFormat.warning).toBe(
        "Custom format was skipped: Not supported",
      );
    }

    class ForeignRefusal extends second.TransportableError {
      constructor() {
        super("US_ONLY_UNAVAILABLE", "blocked");
      }

      get endsEngineLoop(): boolean {
        return true;
      }

      get propagateFromExtraction(): boolean {
        return true;
      }

      get httpStatus(): number {
        return 403;
      }

      get scrapeLog() {
        return {
          errorType: "ForeignRefusal",
          message: "scrapeURL: Foreign refusal",
          context: { error: this, reason: "policy" },
        };
      }
    }

    const foreign = new ForeignRefusal();
    expect(foreign instanceof TransportableError).toBe(false);
    expect(endsEngineLoop(foreign)).toBe(true);
    expect(abortsEngineRace(foreign)).toBe(false);
    expect(stopsCrawlRetry(foreign)).toBe(false);
    expect(shouldPropagateFromExtraction(foreign)).toBe(true);
    expect(getErrorHttpResponse(foreign)).toEqual({
      status: 403,
      code: "US_ONLY_UNAVAILABLE",
      message: "blocked",
    });
    expect(getErrorScrapeLog(foreign)).toEqual({
      errorType: "ForeignRefusal",
      message: "scrapeURL: Foreign refusal",
      context: { error: foreign, reason: "policy" },
    });
  });
});

describe("scrapeLog diagnostics metadata", () => {
  it("preserves established errorType, warning text, and structured context across round-trips", () => {
    const siteRestriction = new SiteRestrictionError();
    const paywalled = new PaywalledContentError();

    expect(getErrorScrapeLog(siteRestriction)).toEqual({
      errorType: "SiteRestrictionError",
      message: "scrapeURL: Site restriction returned (Safe Mode)",
      context: { error: siteRestriction },
    });
    expect(getErrorScrapeLog(paywalled)).toEqual({
      errorType: "PaywalledContentError",
      message: "scrapeURL: Paywalled page refused by Safe Mode",
    });

    for (const error of [siteRestriction, paywalled]) {
      const revived = deserializeTransportableError(
        serializeTransportableError(error),
      )!;
      const log = getErrorScrapeLog(revived);
      expect(log, error.constructor.name).toBeDefined();
      expect(log!.errorType).toBe(getErrorScrapeLog(error)!.errorType);
      expect(log!.message).toBe(getErrorScrapeLog(error)!.message);
      if (error === paywalled) {
        expect(log!.context).toBeUndefined();
      } else {
        expect(log!.context).toEqual({ error: revived });
      }
    }

    expect(getErrorScrapeLog(new NoCachedDataError())).toBeUndefined();
    expect(
      getErrorScrapeLog(new TransportableError("UNKNOWN_ERROR", "plain")),
    ).toBeUndefined();
    expect(getErrorScrapeLog(new Error("plain"))).toBeUndefined();
    expect(
      getErrorScrapeLog({
        scrapeLog: { errorType: "Fake", message: "not an error" },
      }),
    ).toBeUndefined();
    expect(
      getErrorScrapeLog(
        Object.assign(new Error("bad"), {
          scrapeLog: { errorType: "", message: "empty type" },
        }),
      ),
    ).toBeUndefined();
  });
});
