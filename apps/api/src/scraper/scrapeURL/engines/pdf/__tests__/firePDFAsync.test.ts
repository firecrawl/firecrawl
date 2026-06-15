// Stub the GCS cache so unit tests never reach real cloud storage. The async
// client calls these on the happy path; without the stub the first cache lookup
// blows up trying to download from GCS using the credentials in .env.
vi.mock("../../../../../lib/gcs-pdf-cache", () => ({
  createPdfCacheKey: (s: string) => `sha-${s.length}`,
  getPdfResultFromCache: vi.fn(async () => null),
  savePdfResultToCache: vi.fn(async () => null),
}));

import {
  FirePdfAsyncFailure,
  scrapePDFWithFirePDFAsync,
} from "../fire-pdf/async";
import { config } from "../../../../../config";

// ── Fixtures ─────────────────────────────────────────────────────────────

const BASE_URL_ENV = "FIRE_PDF_BASE_URL";
const ORIGINAL_BASE_URL = process.env[BASE_URL_ENV];

beforeAll(() => {
  // Tests build URLs against this; the config object reads the env via zod
  // at module init, so set both for safety.
  process.env[BASE_URL_ENV] = "http://fire-pdf.test";
  (config as { FIRE_PDF_BASE_URL?: string }).FIRE_PDF_BASE_URL =
    "http://fire-pdf.test";
});

afterAll(() => {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env[BASE_URL_ENV];
  } else {
    process.env[BASE_URL_ENV] = ORIGINAL_BASE_URL;
  }
});

type FakeResponse = {
  status: number;
  body: unknown;
};

function jsonResp({ status, body }: FakeResponse) {
  return {
    status,
    json: async () => body,
  } as any;
}

function makeMeta(overrides: Record<string, unknown> = {}) {
  const noopLogger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function child() {
      return noopLogger;
    }),
  };

  return {
    id: "scrape-id-test",
    url: "https://example.com/doc.pdf",
    rewrittenUrl: undefined,
    logger: noopLogger,
    mock: null,
    abort: {
      throwIfAborted: vi.fn(),
      asSignal: vi.fn(() => new AbortController().signal),
      scrapeTimeout: vi.fn(() => 60_000),
    },
    internalOptions: {
      zeroDataRetention: false,
      teamId: "team-x",
      crawlId: undefined,
    },
    options: {
      parsers: [{ type: "pdf", __firePdfAsync: true }],
    },
    ...overrides,
  } as any;
}

function makeFetchFromSequence(
  matchers: Array<{
    matchUrl: RegExp;
    matchMethod?: "GET" | "POST";
    response: FakeResponse | (() => FakeResponse);
  }>,
) {
  const calls: Array<{ url: string; method: string }> = [];
  const cursor = { idx: 0 };
  const fetchImpl: any = async (url: string, init: any) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const matcher = matchers[cursor.idx++];
    if (!matcher) {
      throw new Error(
        `unexpected request #${cursor.idx} to ${method} ${url} (no matcher left)`,
      );
    }
    if (!matcher.matchUrl.test(url)) {
      throw new Error(
        `request ${cursor.idx} url mismatch: got ${url}, expected ${matcher.matchUrl}`,
      );
    }
    if (matcher.matchMethod && matcher.matchMethod !== method) {
      throw new Error(
        `request ${cursor.idx} method mismatch: got ${method}, expected ${matcher.matchMethod}`,
      );
    }
    const r =
      typeof matcher.response === "function"
        ? matcher.response()
        : matcher.response;
    return jsonResp(r);
  };
  return { fetchImpl, calls };
}

const noopSleep = async () => {};

// ── Tests ────────────────────────────────────────────────────────────────

describe("scrapePDFWithFirePDFAsync", () => {
  it("happy path: POST 202 queued → poll done → result returns markdown", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 202,
          body: {
            scrape_id: "scrape-id-test",
            status: "queued",
            lane: "fast",
            retry_after_ms: 50,
          },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "GET",
        response: { status: 202, body: { scrape_id: "x", status: "running" } },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "GET",
        response: {
          status: 200,
          body: {
            scrape_id: "x",
            status: "done",
            pages_processed: 12,
          },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: {
          status: 200,
          body: {
            schema_version: 1,
            markdown: "# Hello async",
            pages_processed: 12,
            failed_pages: null,
            partial_pages: null,
          },
        },
      },
    ]);
    const fallback = vi.fn();

    const result = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    );

    expect(result.markdown).toBe("# Hello async");
    expect(result.pagesProcessed).toBe(12);
    expect(fallback).not.toHaveBeenCalled();
    expect(calls).toHaveLength(4);
  });

  it("idempotent replay: POST 200 done skips polling and fetches result", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 200,
          body: { scrape_id: "scrape-id-test", status: "done" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: {
          status: 200,
          body: { markdown: "cached", pages_processed: 3 },
        },
      },
    ]);
    const fallback = vi.fn();

    const result = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    );

    expect(result.markdown).toBe("cached");
    expect(fallback).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["404", 404, "http_404"],
    ["413", 413, "http_413"],
    ["429", 429, "http_429"],
    ["503", 503, "http_503"],
    ["generic 5xx", 500, "http_5xx"],
  ])(
    "throws FirePdfAsyncFailure when POST /jobs returns %s",
    async (_, status, reason) => {
      const { fetchImpl } = makeFetchFromSequence([
        {
          matchUrl: /\/jobs$/,
          matchMethod: "POST",
          response: { status, body: { error: "x" } },
        },
      ]);
      const fallback = vi.fn();

      const err = await scrapePDFWithFirePDFAsync(
        makeMeta(),
        "BASE64",
        undefined,
        undefined,
        undefined,
        { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
      ).catch(e => e);

      expect(err).toBeInstanceOf(FirePdfAsyncFailure);
      expect(err.reason).toBe(reason);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it("throws FirePdfAsyncFailure when POST /jobs throws a network error", async () => {
    const fetchImpl: any = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const fallback = vi.fn();

    const err = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    ).catch(e => e);

    expect(err).toBeInstanceOf(FirePdfAsyncFailure);
    expect(err.reason).toBe("network_error");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws on POST 409 scrape_id conflict (fatal, no fallback)", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 409,
          body: { error: "scrape_id_conflict", conflict_fields: ["pdf_b64"] },
        },
      },
    ]);
    const fallback = vi.fn();

    await expect(
      scrapePDFWithFirePDFAsync(
        makeMeta(),
        "BASE64",
        undefined,
        undefined,
        undefined,
        { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
      ),
    ).rejects.toThrow(/conflict/);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws FirePdfAsyncFailure when polling returns terminal failed (502)", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        response: {
          status: 202,
          body: { scrape_id: "x", status: "queued" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        response: {
          status: 502,
          body: {
            scrape_id: "x",
            status: "failed",
            error_class: "worker_oom",
            error_message: "ran out of memory",
          },
        },
      },
    ]);
    const fallback = vi.fn();

    const err = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    ).catch(e => e);

    expect(err).toBeInstanceOf(FirePdfAsyncFailure);
    expect(err.reason).toBe("terminal_failed");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws FirePdfAsyncFailure when polling returns 410 (expired)", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        response: {
          status: 202,
          body: { scrape_id: "x", status: "queued" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        response: {
          status: 410,
          body: { scrape_id: "x", status: "expired" },
        },
      },
    ]);
    const fallback = vi.fn();

    const err = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    ).catch(e => e);

    expect(err).toBeInstanceOf(FirePdfAsyncFailure);
    expect(err.reason).toBe("terminal_expired");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws FirePdfAsyncFailure when polling exceeds deadline + buffer", async () => {
    let virtualNow = 1_000_000;
    const advance = (ms: number) => {
      virtualNow += ms;
    };

    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        response: {
          status: 202,
          body: {
            scrape_id: "x",
            status: "queued",
            retry_after_ms: 1000,
          },
        },
      },
      // Subsequent polls — won't be reached if timeout triggers correctly,
      // but provide one just in case the loop runs one iteration.
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        response: { status: 202, body: { scrape_id: "x", status: "running" } },
      },
    ]);
    const fallback = vi.fn();

    // 5s scrape budget → deadline 5s, polling deadline = submit + 5s + 30s = 35s.
    // Each sleep advances time by 60s, blowing past the polling deadline.
    const meta = makeMeta({
      abort: {
        throwIfAborted: vi.fn(),
        asSignal: vi.fn(() => new AbortController().signal),
        scrapeTimeout: vi.fn(() => 5_000),
      },
    });

    const err = await scrapePDFWithFirePDFAsync(
      meta,
      "BASE64",
      undefined,
      undefined,
      undefined,
      {
        fetchImpl,
        fallbackImpl: fallback,
        sleepImpl: async ms => advance(ms + 60_000),
        nowImpl: () => virtualNow,
      },
    ).catch(e => e);

    expect(err).toBeInstanceOf(FirePdfAsyncFailure);
    expect(err.reason).toBe("polling_timeout");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws FirePdfAsyncFailure when result endpoint returns 503", async () => {
    const { fetchImpl } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        response: {
          status: 202,
          body: { scrape_id: "x", status: "queued" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        response: {
          status: 200,
          body: { scrape_id: "x", status: "done", pages_processed: 5 },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        response: { status: 503, body: { error: "gcs_unreachable" } },
      },
    ]);
    const fallback = vi.fn();

    const err = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    ).catch(e => e);

    expect(err).toBeInstanceOf(FirePdfAsyncFailure);
    expect(err.reason).toBe("result_503");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("re-polls once on result 409, then succeeds", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 202,
          body: { scrape_id: "x", status: "queued" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "GET",
        response: {
          status: 200,
          body: { scrape_id: "x", status: "done", pages_processed: 7 },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: { status: 409, body: { error: "status_flipped" } },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: {
          status: 200,
          body: { markdown: "ok", pages_processed: 7 },
        },
      },
    ]);
    const fallback = vi.fn();

    const result = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: fallback, sleepImpl: noopSleep },
    );

    expect(result.markdown).toBe("ok");
    expect(fallback).not.toHaveBeenCalled();
    expect(calls).toHaveLength(4);
  });

  it("deadline_at is within the spec'd [5s, 30min] window", async () => {
    let submittedBody: any;
    const fetchImpl: any = async (url: string, init: any) => {
      if (/\/jobs$/.test(url) && (init?.method ?? "GET") === "POST") {
        submittedBody = JSON.parse(init.body as string);
        return jsonResp({
          status: 202,
          body: { scrape_id: "x", status: "queued" },
        });
      }
      if (/\/jobs\/scrape-id-test$/.test(url)) {
        return jsonResp({
          status: 200,
          body: { scrape_id: "x", status: "done", pages_processed: 1 },
        });
      }
      return jsonResp({
        status: 200,
        body: { markdown: "ok", pages_processed: 1 },
      });
    };

    await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: vi.fn(), sleepImpl: noopSleep },
    );

    const deadlineMs = new Date(submittedBody.deadline_at).getTime();
    const delta = deadlineMs - Date.now();
    // Within the spec: 5s < delta < 30min. Loose lower bound because clock
    // can drift slightly during the test.
    expect(delta).toBeGreaterThanOrEqual(5_000 - 100);
    expect(delta).toBeLessThanOrEqual(30 * 60 * 1_000);
  });
});
