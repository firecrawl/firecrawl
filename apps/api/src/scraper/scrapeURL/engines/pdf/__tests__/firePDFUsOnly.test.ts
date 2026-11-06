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
import { savePdfResultToCache } from "../../../../../lib/gcs-pdf-cache";
import { UsOnlyUnavailableError } from "../../../error";
import { scrapePDFWithFirePDF } from "../firePDF";
import { scrapePDFWithFirePDFAsync } from "../fire-pdf/async";
import { lookupAdoptableFirePdfJob } from "../fire-pdf/lookup";
import { buildFirePdfJobOptions, FirePdfAsyncFailure } from "../fire-pdf/utils";
import {
  makeFetchFromSequence,
  makeMeta as makeAsyncMeta,
  noopSleep,
} from "./firePDFAsyncFixtures";

const mockedRobustFetch = vi.mocked(robustFetch);

const usOnlyFlags = { usOnly: true };

function makeSyncMeta(teamFlags?: Record<string, unknown>) {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    id: "us-only-sync-test",
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

function makeUsOnlyAsyncMeta(teamFlags?: Record<string, unknown>) {
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

// The PDF service's sync answer when every in-region GPU acquire was refused.
const pinnedNoCapacity = {
  error: "No OCR pods available",
  data_region_refusals: { region_unroutable: 3 },
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

describe("FirePDF sync parse for US-only teams", () => {
  it("sends data_region only for a US-only team", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "Document",
      failed_pages: null,
      pages_processed: 1,
      data_region_applied: "us",
    } as any);

    await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1);
    await scrapePDFWithFirePDF(makeSyncMeta(usOnlyFlags), "BASE64", 1);

    const unpinned = mockedRobustFetch.mock.calls[0][0].body;
    const pinned = mockedRobustFetch.mock.calls[1][0].body;
    expect(Object.hasOwn(unpinned, "data_region")).toBe(false);
    expect(pinned.data_region).toBe("us");
  });

  it("returns a US-only result that carries the region echo", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "Document",
      failed_pages: null,
      pages_processed: 1,
      data_region_applied: "us",
    } as any);

    const result = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    );

    expect(result.markdown).toBe("Document");
  });

  it("refuses a US-only parse the PDF service could not place on US capacity", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, pinnedNoCapacity));

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(error.code).toBe("US_ONLY_UNAVAILABLE");
    expect(error.message).toContain("PDF parsing is not available");
  });

  it("keeps a US-only failure without region refusals on its own error", async () => {
    const failure = failureStatus(502, { error: "All 3 pages failed" });
    mockedRobustFetch.mockRejectedValue(failure);

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBe(failure);
  });

  it.each([
    ["missing", {}],
    ["null", { data_region_applied: null }],
    [
      "null with refusals",
      {
        data_region_applied: null,
        data_region_refusals: { region_unverified: 1 },
      },
    ],
  ])(
    "refuses a US-only result whose region echo is %s",
    async (_name, echo) => {
      mockedRobustFetch.mockResolvedValue({
        markdown: "Document",
        failed_pages: null,
        pages_processed: 1,
        ...echo,
      } as any);

      const error = await scrapePDFWithFirePDF(
        makeSyncMeta(usOnlyFlags),
        "BASE64",
        1,
      ).catch(e => e);

      expect(error).toBeInstanceOf(UsOnlyUnavailableError);
      expect(error.message).toContain("did not confirm US-only processing");
    },
  );

  it("names image OCR when a US-only image is refused", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, pinnedNoCapacity));

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
      1,
      "ocr",
      false,
      false,
      false,
      "image",
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(error.message).toContain("Image OCR is not available");
  });

  it("keeps an unpinned failure and an unpinned result without the echo unchanged", async () => {
    const failure = failureStatus(503, pinnedNoCapacity);
    mockedRobustFetch.mockRejectedValueOnce(failure);
    expect(
      await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1).catch(e => e),
    ).toBe(failure);

    mockedRobustFetch.mockResolvedValueOnce({
      markdown: "Document",
      failed_pages: null,
      pages_processed: 1,
    } as any);
    const result = await scrapePDFWithFirePDF(makeSyncMeta(), "BASE64", 1);
    expect(result.markdown).toBe("Document");
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

describe("FirePDF async jobs for US-only teams", () => {
  it("sends data_region in the job options only for a US-only team", async () => {
    const unpinned = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ data_region_applied: null }),
    ]);
    await runAsync(makeUsOnlyAsyncMeta(), unpinned.fetchImpl);

    const pinned = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ data_region_applied: "us" }),
    ]);
    const result = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      pinned.fetchImpl,
    );

    expect(unpinned.calls[0].body).not.toHaveProperty("data_region");
    expect(unpinned.calls[0].body).not.toHaveProperty("options.data_region");
    expect(pinned.calls[0].body).not.toHaveProperty("data_region");
    expect(pinned.calls[0].body).toHaveProperty("options.data_region", "us");
    expect(result.markdown).toBe("# Async");
  });

  it("refuses a US-only job that failed for lack of US capacity, without cancelling it", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      submitAccepted,
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "GET",
        response: {
          status: 502,
          body: {
            scrape_id: "scrape-id-test",
            data_region_applied: "us",
            status: "failed",
            error_class: "ocr_unavailable",
            error_message:
              "No OCR pods available [data_region=us refused: region_unroutable=4]",
          },
        },
      },
    ]);

    const error = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(calls.map(call => call.method)).toEqual(["POST", "GET"]);
  });

  it("keeps a US-only job that finished in the region despite refused acquires", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      submitAccepted,
      {
        ...pollDone,
        response: {
          status: 200,
          body: {
            ...pollDone.response.body,
            data_region_refusals: { region_cap: 1 },
          },
        },
      },
      resultWith({ data_region_applied: "us" }),
    ]);

    const result = await runAsync(makeUsOnlyAsyncMeta(usOnlyFlags), fetchImpl);

    expect(result.markdown).toBe("# Async");
  });

  it("keeps a US-only job failure without region refusals off the US-only refusal", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      submitAccepted,
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "GET",
        response: {
          status: 502,
          body: {
            scrape_id: "scrape-id-test",
            data_region_applied: "us",
            status: "failed",
            error_class: "render_failed",
            error_message: "Batch render failed",
          },
        },
      },
    ]);

    const error = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(FirePdfAsyncFailure);
    expect(error.reason).toBe("terminal_failed");
  });

  it("refuses a US-only result that lacks the region echo and caches nothing", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({}),
    ]);

    const error = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(savePdfResultToCache).not.toHaveBeenCalled();
  });

  it("forwards data_region from the caller's job options to the content lookup", async () => {
    const lookupHit = {
      matchUrl: /\/jobs\/lookup$/,
      matchMethod: "POST" as const,
      response: {
        status: 200,
        body: { scrape_id: "found-1", status: "running" },
      },
    };
    const unpinned = makeFetchFromSequence([lookupHit]);
    const pinned = makeFetchFromSequence([lookupHit]);
    const sha = "ef".repeat(32);

    const jobOptions = (dataRegion?: string) =>
      buildFirePdfJobOptions({
        maxPages: undefined,
        pagesProcessed: undefined,
        mode: "auto",
        includePageMarkdown: false,
        includeBlocks: false,
        pageMarkers: false,
        tableFormat: undefined,
        trainingCapture: undefined,
        dataRegion,
      });

    await lookupAdoptableFirePdfJob(
      makeUsOnlyAsyncMeta(),
      sha,
      jobOptions(),
      unpinned.fetchImpl,
    );
    await lookupAdoptableFirePdfJob(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      sha,
      jobOptions("us"),
      pinned.fetchImpl,
    );

    expect(unpinned.calls[0].body).not.toHaveProperty("data_region");
    expect(unpinned.calls[0].body).toHaveProperty("options", { mode: "auto" });
    expect(pinned.calls[0].body).not.toHaveProperty("data_region");
    expect(pinned.calls[0].body).toHaveProperty("options", {
      mode: "auto",
      data_region: "us",
    });
  });
});
