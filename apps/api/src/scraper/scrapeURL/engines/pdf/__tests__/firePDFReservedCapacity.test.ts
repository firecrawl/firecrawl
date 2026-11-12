// Stub the GCS cache so the async client never reaches real cloud storage.
vi.mock("../../../../../lib/gcs-pdf-cache", () => ({
  pdfCacheConfigured: vi.fn(() => true),
  createPdfCacheKey: (s: string) => `sha-${s.length}`,
  resolvePdfCacheKey: (input: string | { key: string }) =>
    typeof input === "string" ? `sha-${input.length}` : input.key,
  getPdfResultFromCache: vi.fn(async () => null),
  savePdfResultToCache: vi.fn(async () => null),
}));
vi.mock("../../../lib/fetch", () => ({
  robustFetch: vi.fn(),
}));

import { robustFetch } from "../../../lib/fetch";
import { config } from "../../../../../config";
import {
  getPdfResultFromCache,
  savePdfResultToCache,
} from "../../../../../lib/gcs-pdf-cache";
import {
  ReservedCapacityUnavailableError,
  UsOnlyUnavailableError,
} from "../../../error";
import { scrapePDFWithFirePDF } from "../firePDF";
import { tryGetCached } from "../fire-pdf/cache";
import { scrapePDFWithFirePDFAsync } from "../fire-pdf/async";
import { lookupAdoptableFirePdfJob } from "../fire-pdf/lookup";
import { buildFirePdfJobOptions, FirePdfAsyncFailure } from "../fire-pdf/utils";
import {
  makeFetchFromSequence,
  makeMeta as makeAsyncMeta,
  noopSleep,
} from "./firePDFAsyncFixtures";

const mockedRobustFetch = vi.mocked(robustFetch);
const mockedGetCached = vi.mocked(getPdfResultFromCache);

const reservedFlags = { reservedCapacity: true };
const bothFlags = { usOnly: true, reservedCapacity: true };

function makeSyncMeta(teamFlags?: Record<string, unknown>) {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    id: "reserved-capacity-sync-test",
    url: "https://example.com/file.pdf",
    rewrittenUrl: undefined,
    options: {},
    logger,
    mock: null,
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: {
      zeroDataRetention: false,
      teamId: "team-test",
      ...(teamFlags && { teamFlags }),
    },
  } as any;
}

function makeReservedAsyncMeta(teamFlags?: Record<string, unknown>) {
  return makeAsyncMeta({
    internalOptions: {
      zeroDataRetention: false,
      teamId: "team-x",
      teamConcurrency: 12,
      crawlId: undefined,
      ...(teamFlags && { teamFlags }),
    },
  });
}

function failureStatus(status: number, body: unknown) {
  return new Error("Request sent failure status", {
    cause: { response: { status, body: JSON.stringify(body) } },
  });
}

const syncResult = (extra: Record<string, unknown>) =>
  ({
    markdown: "Document",
    failed_pages: null,
    pages_processed: 1,
    ...extra,
  }) as any;

// The PDF service's sync answer when the reserved capacity it needed was refused.
const reservedNoCapacity = {
  error: "No OCR pods available",
  reserved_refusals: { reserved_unroutable: 3 },
};

const ORIGINAL_BASE_URL = config.FIRE_PDF_BASE_URL;

beforeAll(() => {
  config.FIRE_PDF_BASE_URL = "http://fire-pdf.test";
});

afterAll(() => {
  config.FIRE_PDF_BASE_URL = ORIGINAL_BASE_URL;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FirePDF sync parse for teams restricted to reserved capacity", () => {
  it("sends reserved only for a restricted team", async () => {
    mockedRobustFetch.mockResolvedValue(syncResult({ reserved_applied: true }));

    await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1);
    await scrapePDFWithFirePDF(makeSyncMeta(reservedFlags), "BASE64", 1);

    const unrestricted = mockedRobustFetch.mock.calls[0][0].body;
    const restricted = mockedRobustFetch.mock.calls[1][0].body;
    expect(Object.hasOwn(unrestricted, "reserved")).toBe(false);
    expect(restricted.reserved).toBe(true);
    expect(Object.hasOwn(restricted, "data_region")).toBe(false);
  });

  it("returns a restricted result that carries the reserved echo", async () => {
    mockedRobustFetch.mockResolvedValue(syncResult({ reserved_applied: true }));

    const result = await scrapePDFWithFirePDF(
      makeSyncMeta(reservedFlags),
      "BASE64",
      1,
    );

    expect(result.markdown).toBe("Document");
  });

  it("refuses a restricted parse the PDF service could not place", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, reservedNoCapacity));

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(reservedFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
    expect(error.code).toBe("RESERVED_CAPACITY_UNAVAILABLE");
    expect(error.message).toContain(
      "PDF processing is unavailable for this team's configuration. Please retry later.",
    );
  });

  it("keeps a restricted failure without reserved refusals on its own error", async () => {
    const failure = failureStatus(502, { error: "All 3 pages failed" });
    mockedRobustFetch.mockRejectedValue(failure);

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(reservedFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBe(failure);
  });

  it.each([
    ["missing", {}],
    ["null", { reserved_applied: null }],
    ["false", { reserved_applied: false }],
  ])(
    "refuses a restricted result whose reserved echo is %s",
    async (_name, echo) => {
      mockedRobustFetch.mockResolvedValue(syncResult(echo));

      const error = await scrapePDFWithFirePDF(
        makeSyncMeta(reservedFlags),
        "BASE64",
        1,
      ).catch(e => e);

      expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
      expect(error.message).toContain(
        "PDF processing is unavailable for this team's configuration. Please retry later.",
      );
    },
  );

  it("uses the same error for a restricted image", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, reservedNoCapacity));

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(reservedFlags),
      "BASE64",
      1,
      1,
      "ocr",
      false,
      false,
      false,
      "image",
    ).catch(e => e);

    expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
    expect(error.message).toContain(
      "PDF processing is unavailable for this team's configuration. Please retry later.",
    );
  });

  it("keeps an unrestricted failure and an unrestricted result without the echo unchanged", async () => {
    const failure = failureStatus(503, reservedNoCapacity);
    mockedRobustFetch.mockRejectedValueOnce(failure);
    expect(
      await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1).catch(e => e),
    ).toBe(failure);

    mockedRobustFetch.mockResolvedValueOnce(syncResult({}));
    const result = await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1);
    expect(result.markdown).toBe("Document");
  });

  describe("with US-only as well", () => {
    it("sends both fields and returns a result carrying both echoes", async () => {
      mockedRobustFetch.mockResolvedValue(
        syncResult({ data_region_applied: "us", reserved_applied: true }),
      );

      const result = await scrapePDFWithFirePDF(
        makeSyncMeta(bothFlags),
        "BASE64",
        1,
      );

      const body = mockedRobustFetch.mock.calls[0][0].body;
      expect(body.data_region).toBe("us");
      expect(body.reserved).toBe(true);
      expect(result.markdown).toBe("Document");
    });

    it.each([
      ["the region echo", { reserved_applied: true }, UsOnlyUnavailableError],
      [
        "the reserved echo",
        { data_region_applied: "us" },
        ReservedCapacityUnavailableError,
      ],
    ])("refuses a result missing %s", async (_name, echo, errorClass) => {
      mockedRobustFetch.mockResolvedValue(syncResult(echo));

      const error = await scrapePDFWithFirePDF(
        makeSyncMeta(bothFlags),
        "BASE64",
        1,
      ).catch(e => e);

      expect(error).toBeInstanceOf(errorClass);
    });

    it("keeps the US-only error when both restrictions were refused", async () => {
      mockedRobustFetch.mockRejectedValue(
        failureStatus(503, {
          ...reservedNoCapacity,
          data_region_refusals: { region_unroutable: 1 },
        }),
      );

      const error = await scrapePDFWithFirePDF(
        makeSyncMeta(bothFlags),
        "BASE64",
        1,
      ).catch(e => e);

      expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    });

    it("maps a reserved-only refusal to the reserved capacity error", async () => {
      mockedRobustFetch.mockRejectedValue(
        failureStatus(503, reservedNoCapacity),
      );

      const error = await scrapePDFWithFirePDF(
        makeSyncMeta(bothFlags),
        "BASE64",
        1,
      ).catch(e => e);

      expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
    });
  });
});

const submitAccepted = {
  matchUrl: /\/jobs$/,
  matchMethod: "POST" as const,
  response: {
    status: 202,
    body: { scrape_id: "scrape-id-test", status: "queued", lane: "fast" },
  },
};
const pollDone = {
  matchUrl: /\/jobs\/scrape-id-test$/,
  matchMethod: "GET" as const,
  response: {
    status: 200,
    body: { scrape_id: "scrape-id-test", status: "done", pages_processed: 3 },
  },
};
function resultWith(extra: Record<string, unknown>) {
  return {
    matchUrl: /\/jobs\/scrape-id-test\/result$/,
    matchMethod: "GET" as const,
    response: {
      status: 200,
      body: {
        schema_version: 1,
        markdown: "# Async",
        pages_processed: 3,
        failed_pages: null,
        partial_pages: null,
        ...extra,
      },
    },
  };
}
function pollFailed(errorMessage: string) {
  return {
    matchUrl: /\/jobs\/scrape-id-test$/,
    matchMethod: "GET" as const,
    response: {
      status: 502,
      body: {
        scrape_id: "scrape-id-test",
        reserved_applied: true,
        status: "failed",
        error_class: "ocr_unavailable",
        error_message: errorMessage,
      },
    },
  };
}

function runAsync(meta: any, fetchImpl: any) {
  return scrapePDFWithFirePDFAsync(
    meta,
    "BASE64",
    undefined,
    undefined,
    undefined,
    { fetchImpl, fallbackImpl: vi.fn(), sleepImpl: noopSleep },
  );
}

describe("FirePDF async jobs for teams restricted to reserved capacity", () => {
  it("sends reserved in the job options only for a restricted team", async () => {
    const unrestricted = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ reserved_applied: null }),
    ]);
    await runAsync(makeReservedAsyncMeta(), unrestricted.fetchImpl);

    const restricted = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ reserved_applied: true }),
    ]);
    const result = await runAsync(
      makeReservedAsyncMeta(reservedFlags),
      restricted.fetchImpl,
    );

    expect(unrestricted.calls[0].body).not.toHaveProperty("reserved");
    expect(unrestricted.calls[0].body).not.toHaveProperty("options.reserved");
    expect(restricted.calls[0].body).not.toHaveProperty("reserved");
    expect(restricted.calls[0].body).toHaveProperty("options.reserved", true);
    expect(restricted.calls[0].body).not.toHaveProperty("options.data_region");
    expect(result.markdown).toBe("# Async");
  });

  it("refuses a restricted job that failed for lack of reserved capacity, without cancelling it", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      submitAccepted,
      pollFailed(
        "No OCR pods available [reserved refused: reserved_unroutable=4]",
      ),
    ]);

    const error = await runAsync(
      makeReservedAsyncMeta(reservedFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
    expect(calls.map(call => call.method)).toEqual(["POST", "GET"]);
  });

  it("keeps a restricted job failure without reserved refusals off the restriction error", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      submitAccepted,
      pollFailed("Batch render failed"),
    ]);

    const error = await runAsync(
      makeReservedAsyncMeta(reservedFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(FirePdfAsyncFailure);
    expect(error.reason).toBe("terminal_failed");
  });

  it.each([
    ["missing", {}],
    ["null", { reserved_applied: null }],
    ["false", { reserved_applied: false }],
  ])(
    "refuses a restricted result whose reserved echo is %s and caches nothing",
    async (_name, echo) => {
      const { fetchImpl } = makeFetchFromSequence([
        submitAccepted,
        pollDone,
        resultWith(echo),
      ]);

      const error = await runAsync(
        makeReservedAsyncMeta(reservedFlags),
        fetchImpl,
      ).catch(e => e);

      expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
      expect(savePdfResultToCache).not.toHaveBeenCalled();
    },
  );

  describe("by reference", () => {
    const byReference = {
      gcsUri: "gs://bucket/inputs/scrape-id-test.pdf",
      sha256: "ab".repeat(32),
      sizeBytes: 200 * 1024 * 1024,
    };
    const runByReference = (meta: any, fetchImpl: any) =>
      scrapePDFWithFirePDFAsync(meta, byReference, undefined, 3, undefined, {
        fetchImpl,
        fallbackImpl: vi.fn(),
        sleepImpl: noopSleep,
      });

    it("sends reserved in the job options and accepts the reserved echo", async () => {
      const { fetchImpl, calls } = makeFetchFromSequence([
        submitAccepted,
        pollDone,
        resultWith({ reserved_applied: true }),
      ]);

      const result = await runByReference(
        makeReservedAsyncMeta(reservedFlags),
        fetchImpl,
      );

      expect(calls[0].body).toHaveProperty("input_gcs_uri", byReference.gcsUri);
      expect(calls[0].body).toHaveProperty("options.reserved", true);
      expect(result.markdown).toBe("# Async");
    });

    it("refuses a result without the reserved echo and caches nothing", async () => {
      const { fetchImpl } = makeFetchFromSequence([
        submitAccepted,
        pollDone,
        resultWith({}),
      ]);

      const error = await runByReference(
        makeReservedAsyncMeta(reservedFlags),
        fetchImpl,
      ).catch(e => e);

      expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
      expect(savePdfResultToCache).not.toHaveBeenCalled();
    });
  });

  it("sends both restrictions and requires both echoes for a team with both flags", async () => {
    const both = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ data_region_applied: "us", reserved_applied: true }),
    ]);
    const result = await runAsync(
      makeReservedAsyncMeta(bothFlags),
      both.fetchImpl,
    );
    expect(both.calls[0].body).toHaveProperty("options.data_region", "us");
    expect(both.calls[0].body).toHaveProperty("options.reserved", true);
    expect(result.markdown).toBe("# Async");

    const regionOnly = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ data_region_applied: "us" }),
    ]);
    const error = await runAsync(
      makeReservedAsyncMeta(bothFlags),
      regionOnly.fetchImpl,
    ).catch(e => e);
    expect(error).toBeInstanceOf(ReservedCapacityUnavailableError);
  });

  it("forwards reserved from the caller's job options to the content lookup", async () => {
    const lookupHit = {
      matchUrl: /\/jobs\/lookup$/,
      matchMethod: "POST" as const,
      response: {
        status: 200,
        body: { scrape_id: "found-1", status: "running" },
      },
    };
    const restricted = makeFetchFromSequence([lookupHit]);

    await lookupAdoptableFirePdfJob(
      makeReservedAsyncMeta(reservedFlags),
      "ef".repeat(32),
      buildFirePdfJobOptions({
        maxPages: undefined,
        pagesProcessed: undefined,
        mode: "auto",
        includePageMarkdown: false,
        includeBlocks: false,
        pageMarkers: false,
        tableFormat: undefined,
        trainingCapture: undefined,
        dataRegion: undefined,
        reserved: true,
      }),
      restricted.fetchImpl,
    );

    expect(restricted.calls[0].body).not.toHaveProperty("reserved");
    expect(restricted.calls[0].body).toHaveProperty("options", {
      mode: "auto",
      reserved: true,
    });
  });
});

describe("FirePDF content cache for teams restricted to reserved capacity", () => {
  const cachedEntry = { markdown: "cached", html: "<p>cached</p>" } as any;

  afterEach(() => {
    config.FIRE_PDF_CACHE_BASE_URL = undefined;
  });

  it("never reads the cache for a restricted team but still writes its result", async () => {
    mockedGetCached.mockResolvedValue(cachedEntry);
    mockedRobustFetch.mockResolvedValue(syncResult({ reserved_applied: true }));

    const result = await scrapePDFWithFirePDF(
      makeSyncMeta(reservedFlags),
      "BASE64",
    );

    expect(result.markdown).toBe("Document");
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedRobustFetch).toHaveBeenCalledTimes(1);
    expect(savePdfResultToCache).toHaveBeenCalled();
  });

  it.each([
    ["an unrestricted team", undefined],
    ["a US-only team", { usOnly: true }],
  ])("still serves %s from the cache", async (_name, flags) => {
    mockedGetCached.mockResolvedValue(cachedEntry);

    const result = await scrapePDFWithFirePDF(makeSyncMeta(flags), "BASE64");

    expect(result.markdown).toBe("cached");
    expect(mockedRobustFetch).not.toHaveBeenCalled();
  });

  it("skips the cache service lookup for a restricted team", async () => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache.test";
    mockedRobustFetch.mockResolvedValue(syncResult({ reserved_applied: true }));

    await scrapePDFWithFirePDF(makeSyncMeta(reservedFlags), "BASE64");

    const urls = mockedRobustFetch.mock.calls.map(call => call[0].url);
    expect(urls).toEqual(["http://fire-pdf.test/ocr"]);
  });

  it("still records the raw cache key for the URL index without a lookup", async () => {
    config.FIRE_PDF_CACHE_BASE_URL = "http://cache.test";
    const meta = { ...makeSyncMeta(reservedFlags), firePdfCacheKey: {} };
    const rawKey = `raw-${"cd".repeat(32)}`;

    const cached = await tryGetCached(
      meta,
      { key: rawKey },
      "auto",
      undefined,
      3,
      false,
      false,
    );

    expect(cached).toBeNull();
    expect(meta.firePdfCacheKey).toEqual({ current: rawKey });
    expect(mockedRobustFetch).not.toHaveBeenCalled();
  });

  it("skips the content cache read on async jobs for a restricted team", async () => {
    mockedGetCached.mockResolvedValue(cachedEntry);
    const { fetchImpl, calls } = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ reserved_applied: true }),
    ]);

    const result = await runAsync(
      makeReservedAsyncMeta(reservedFlags),
      fetchImpl,
    );

    expect(result.markdown).toBe("# Async");
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(calls[0].method).toBe("POST");
  });
});
