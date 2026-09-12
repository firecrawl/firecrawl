// Stub the GCS cache so unit tests never reach real cloud storage — same
// setup as firePDFAsync.test.ts, which covers the orchestration end to end.
vi.mock("../../../../../lib/gcs-pdf-cache", () => ({
  createPdfCacheKey: (s: string) => `sha-${s.length}`,
  getPdfResultFromCache: vi.fn(async () => null),
  savePdfResultToCache: vi.fn(async () => null),
}));

import {
  FirePdfAsyncFailure,
  scrapePDFWithFirePDFAsync,
} from "../fire-pdf/async";
import {
  firePdfAsyncAbandonedTotal,
  firePdfAsyncSubmitRetriesTotal,
} from "../fire-pdf/metrics";
import { AbortManagerThrownError } from "../../../lib/abortManager";
import { config } from "../../../../../config";
import {
  counterValue,
  jsonResp,
  makeFetchFromSequence,
  makeMeta,
  noopSleep,
} from "./firePDFAsyncFixtures";

const BASE_URL_ENV = "FIRE_PDF_BASE_URL";
const ORIGINAL_BASE_URL = process.env[BASE_URL_ENV];

beforeAll(() => {
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

// How an inline async attempt behaves around the caller's window: the job
// deadline it advertises, how polling tracks that deadline, the one submit
// retry for a request that never reached fire-pdf, and what is counted when
// the caller's window closes first.
describe("scrapePDFWithFirePDFAsync — deadline and submit lifecycle", () => {
  it("advertises an inline job deadline with a margin inside the caller window", async () => {
    let submittedBody: any;
    const virtualNow = 1_700_000_000_000;
    const fetchImpl: any = async (url: string, init: any) => {
      if (/\/jobs$/.test(url) && (init?.method ?? "GET") === "POST") {
        submittedBody = JSON.parse(init.body as string);
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

    // 60s caller window → 10s margin (10% is 6s, floored at 10s) → 50s job.
    await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      {
        fetchImpl,
        fallbackImpl: vi.fn(),
        sleepImpl: noopSleep,
        nowImpl: () => virtualNow,
      },
    );

    expect(submittedBody.deadline_at).toBe(
      new Date(virtualNow + 50_000).toISOString(),
    );
  });

  it("polls land just after the job deadline and at the floor thereafter", async () => {
    let virtualNow = 1_000_000;
    const sleeps: number[] = [];
    const pollTimes: number[] = [];
    let polls = 0;
    const fetchImpl: any = async (url: string, init: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (/\/jobs$/.test(url) && method === "POST") {
        return jsonResp({
          status: 202,
          body: {
            scrape_id: "x",
            status: "queued",
            lane: "standard",
            retry_after_ms: 1000,
          },
        });
      }
      if (/\/jobs\/scrape-id-test$/.test(url)) {
        polls++;
        pollTimes.push(virtualNow - 1_000_000);
        // Running until the poll after the job deadline; done on the next.
        return jsonResp(
          polls <= 6
            ? { status: 202, body: { scrape_id: "x", status: "running" } }
            : {
                status: 200,
                body: { scrape_id: "x", status: "done", pages_processed: 3 },
              },
        );
      }
      return jsonResp({
        status: 200,
        body: { markdown: "ok", pages_processed: 3 },
      });
    };

    // 30s caller window → 20s job deadline. Backoff without jitter runs
    // 1s, 2s, 4s, 5s, 5s (t=17s); the next 5s sleep would overshoot the
    // deadline, so it is cut to land at 21s (deadline + 1s grace); still
    // running there, so the following poll comes after the 1s floor.
    const meta = makeMeta({
      abort: {
        throwIfAborted: vi.fn(),
        asSignal: vi.fn(() => new AbortController().signal),
        scrapeTimeout: vi.fn(() => 30_000),
      },
    });
    const result = await scrapePDFWithFirePDFAsync(
      meta,
      "BASE64",
      undefined,
      undefined,
      undefined,
      {
        fetchImpl,
        fallbackImpl: vi.fn(),
        sleepImpl: async ms => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        nowImpl: () => virtualNow,
        randomImpl: () => 0,
      },
    );

    expect(result.markdown).toBe("ok");
    expect(sleeps).toEqual([1000, 2000, 4000, 5000, 5000, 4000, 1000]);
    expect(pollTimes).toEqual([1000, 3000, 7000, 12000, 17000, 21000, 22000]);
  });

  it("retries the submit once when a closing api pod answers with Fastify's 503 body", async () => {
    const before = await counterValue(firePdfAsyncSubmitRetriesTotal, {
      trigger: "http_503_closing",
    });
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 503,
          body: {
            error: "Service Unavailable",
            message: "Service Unavailable",
            statusCode: 503,
          },
        },
      },
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 200,
          body: { scrape_id: "scrape-id-test", status: "done", lane: "fast" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: { status: 200, body: { markdown: "ok", pages_processed: 1 } },
      },
    ]);

    const result = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: vi.fn(), sleepImpl: noopSleep },
    );

    expect(result.markdown).toBe("ok");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(2);
    expect(
      await counterValue(firePdfAsyncSubmitRetriesTotal, {
        trigger: "http_503_closing",
      }),
    ).toBe(before + 1);
  });

  it("does not retry fire-pdf's own 503 codes", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 503,
          body: {
            error: "admission_rejected",
            message: "queue cannot drain within the submitted deadline",
          },
        },
      },
    ]);

    const error = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: vi.fn(), sleepImpl: noopSleep },
    ).catch(e => e);

    expect(error).toBeInstanceOf(FirePdfAsyncFailure);
    expect(error.reason).toBe("http_503");
    expect(calls).toHaveLength(1);
  });

  it("retries the submit once on a transport failure, then proceeds", async () => {
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: () => {
          throw new Error("socket hang up");
        },
      },
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 200,
          body: { scrape_id: "scrape-id-test", status: "done", lane: "fast" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test\/result$/,
        matchMethod: "GET",
        response: { status: 200, body: { markdown: "ok", pages_processed: 1 } },
      },
    ]);

    const result = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      { fetchImpl, fallbackImpl: vi.fn(), sleepImpl: noopSleep },
    );

    expect(result.markdown).toBe("ok");
    expect(calls.filter(c => c.method === "POST")).toHaveLength(2);
  });

  it("counts an attempt abandoned by the caller's abort while polling, and still cancels", async () => {
    const before = await counterValue(firePdfAsyncAbandonedTotal, {
      phase: "poll",
    });
    const { fetchImpl, calls } = makeFetchFromSequence([
      {
        matchUrl: /\/jobs$/,
        matchMethod: "POST",
        response: {
          status: 202,
          body: { scrape_id: "scrape-id-test", status: "queued", lane: "fast" },
        },
      },
      {
        matchUrl: /\/jobs\/scrape-id-test$/,
        matchMethod: "DELETE",
        response: { status: 200, body: { status: "cancelled" } },
      },
    ]);
    const abort = new AbortManagerThrownError("scrape", new Error("timeout"));

    const error = await scrapePDFWithFirePDFAsync(
      makeMeta(),
      "BASE64",
      undefined,
      undefined,
      undefined,
      {
        fetchImpl,
        fallbackImpl: vi.fn(),
        // The scrape window closes during the first poll sleep.
        sleepImpl: async () => {
          throw abort;
        },
      },
    ).catch(e => e);

    expect(error).toBe(abort);
    expect(calls.map(c => c.method)).toEqual(["POST", "DELETE"]);
    expect(
      await counterValue(firePdfAsyncAbandonedTotal, { phase: "poll" }),
    ).toBe(before + 1);
  });
});
