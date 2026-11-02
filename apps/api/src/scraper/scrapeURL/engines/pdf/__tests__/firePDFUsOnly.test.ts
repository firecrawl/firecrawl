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

const regionRefusal = {
  code: "region_unavailable",
  data_region: "us",
  error: "no in-region capacity",
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
      data_region: "us",
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
      data_region: "us",
    } as any);

    const result = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    );

    expect(result.markdown).toBe("Document");
  });

  it("refuses a US-only parse the PDF service could not place on US capacity", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, regionRefusal));

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
    expect(error.code).toBe("US_ONLY_UNAVAILABLE");
    expect(error.message).toContain("PDF parsing is not available");
  });

  it("refuses a US-only result that lacks the region echo", async () => {
    mockedRobustFetch.mockResolvedValue({
      markdown: "Document",
      failed_pages: null,
      pages_processed: 1,
    } as any);

    const error = await scrapePDFWithFirePDF(
      makeSyncMeta(usOnlyFlags),
      "BASE64",
      1,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
  });

  it("names image OCR when a US-only image is refused", async () => {
    mockedRobustFetch.mockRejectedValue(failureStatus(503, regionRefusal));

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
    const failure = failureStatus(503, regionRefusal);
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
  it("sends data_region on the submit only for a US-only team", async () => {
    const unpinned = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({}),
    ]);
    await runAsync(makeUsOnlyAsyncMeta(), unpinned.fetchImpl);

    const pinned = makeFetchFromSequence([
      submitAccepted,
      pollDone,
      resultWith({ data_region: "us" }),
    ]);
    const result = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      pinned.fetchImpl,
    );

    expect(unpinned.calls[0].body).not.toHaveProperty("data_region");
    expect(pinned.calls[0].body).toMatchObject({ data_region: "us" });
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
            status: "failed",
            error_class: "region_unavailable",
            error_message: "no in-region capacity",
            error_code: "region_unavailable",
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

  it("refuses a US-only submit the PDF service turned away for lack of US capacity", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: { status: 503, body: regionRefusal },
      },
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: { status: 503, body: regionRefusal },
      },
    ]);

    const error = await runAsync(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      fetchImpl,
    ).catch(e => e);

    expect(error).toBeInstanceOf(UsOnlyUnavailableError);
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

  it("sends data_region on the content lookup only for a US-only team", async () => {
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

    await lookupAdoptableFirePdfJob(
      makeUsOnlyAsyncMeta(),
      sha,
      { mode: "auto" },
      unpinned.fetchImpl,
    );
    await lookupAdoptableFirePdfJob(
      makeUsOnlyAsyncMeta(usOnlyFlags),
      sha,
      { mode: "auto" },
      pinned.fetchImpl,
    );

    expect(unpinned.calls[0].body).not.toHaveProperty("data_region");
    expect(pinned.calls[0].body).toMatchObject({
      data_region: "us",
      options: { mode: "auto" },
    });
  });
});
