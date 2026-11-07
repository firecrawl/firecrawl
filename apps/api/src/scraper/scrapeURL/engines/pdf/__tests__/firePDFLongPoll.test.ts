import { firePdfAsyncLongPollTotal } from "../fire-pdf/metrics";
import { longPollWaitFor, pollUntilTerminal } from "../fire-pdf/poll";
import { counterValue, jsonResp, makeMeta } from "./firePDFAsyncFixtures";

const T0 = 1_000_000;
const DEADLINE = T0 + 10 * 60_000;

// Drives pollUntilTerminal on a virtual clock against a fake fire-pdf.
// `holding` decides whether the fake honours wait_ms: when it does, a
// wait_ms request is answered when the job finishes or the wait elapses,
// whichever comes first; when it doesn't, every request answers at once.
async function runLongPoll(opts: {
  longPollWaitMs?: number;
  doneAtMs: number;
  holding: boolean | ((requestIndex: number) => boolean);
  pollingDeadline?: number;
  pagesEstimate?: number;
}) {
  let virtualNow = T0;
  const sleeps: number[] = [];
  const urls: string[] = [];
  const fetchImpl: any = async (url: string) => {
    urls.push(url);
    const wait = Number(new URL(url).searchParams.get("wait_ms") ?? 0);
    const doneAt = T0 + opts.doneAtMs;
    const holds =
      typeof opts.holding === "function"
        ? opts.holding(urls.length - 1)
        : opts.holding;
    if (holds && wait > 0 && virtualNow < doneAt) {
      virtualNow = Math.min(doneAt, virtualNow + wait);
    }
    return virtualNow >= doneAt
      ? jsonResp({
          status: 200,
          body: { scrape_id: "x", status: "done", pages_processed: 1 },
        })
      : jsonResp({
          status: 202,
          body: { scrape_id: "x", status: "running", retry_after_ms: 250 },
        });
  };
  const result = await pollUntilTerminal({
    baseUrl: "http://fire-pdf.test",
    scrapeId: "x",
    pagesEstimate: opts.pagesEstimate,
    pollingDeadline: opts.pollingDeadline ?? DEADLINE,
    meta: makeMeta(),
    fetchImpl,
    sleep: async ms => {
      sleeps.push(ms);
      virtualNow += ms;
    },
    now: () => virtualNow,
    random: () => 0,
    longPollWaitMs: opts.longPollWaitMs,
  });
  return {
    sleeps,
    urls,
    pollCount: result.pollCount,
    seenAtMs: virtualNow - T0,
  };
}

const waitParam = (url: string) =>
  new URL(url).searchParams.get("wait_ms") ?? undefined;

describe("longPollWaitFor", () => {
  it("uses the configured wait while the deadline is far", () => {
    expect(longPollWaitFor(20_000, 5 * 60_000)).toBe(20_000);
  });

  it("shortens the wait to end before the polling deadline", () => {
    expect(longPollWaitFor(20_000, 6_000)).toBe(5_000);
  });

  it("clamps the wait to fire-pdf's 25s cap", () => {
    expect(longPollWaitFor(60_000, 5 * 60_000)).toBe(25_000);
  });

  it("returns 0 when too little time is left to hold a request", () => {
    expect(longPollWaitFor(20_000, 1_500)).toBe(0);
    expect(longPollWaitFor(0, 5 * 60_000)).toBe(0);
  });
});

describe("pollUntilTerminal — wait_ms long-poll", () => {
  it("keeps today's schedule and URL when the wait is not configured", async () => {
    const { sleeps, urls } = await runLongPoll({
      doneAtMs: 2_500,
      holding: true,
    });
    expect(urls.every(u => waitParam(u) === undefined)).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("sends the first poll at once with wait_ms and sees completion when it happens", async () => {
    const before = await counterValue(firePdfAsyncLongPollTotal, {
      outcome: "terminal",
    });
    const { sleeps, urls, pollCount, seenAtMs } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 2_500,
      holding: true,
    });
    expect(sleeps).toEqual([]);
    expect(urls.map(waitParam)).toEqual(["20000"]);
    expect(pollCount).toBe(1);
    expect(seenAtMs).toBe(2_500);
    expect(
      await counterValue(firePdfAsyncLongPollTotal, { outcome: "terminal" }),
    ).toBe(before + 1);
  });

  it("re-polls immediately after a held request times out", async () => {
    const before = await counterValue(firePdfAsyncLongPollTotal, {
      outcome: "held",
    });
    const { sleeps, urls, seenAtMs } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 45_000,
      holding: true,
    });
    expect(sleeps).toEqual([]);
    expect(urls.map(waitParam)).toEqual(["20000", "20000", "20000"]);
    expect(seenAtMs).toBe(45_000);
    expect(
      await counterValue(firePdfAsyncLongPollTotal, { outcome: "held" }),
    ).toBe(before + 2);
  });

  it("falls back to the scheduled polls when the server keeps answering a wait at once", async () => {
    const before = await counterValue(firePdfAsyncLongPollTotal, {
      outcome: "not_held",
    });
    const { sleeps, urls, seenAtMs } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 4_000,
      holding: false,
      pagesEstimate: 3,
    });
    // Two wait_ms requests answered early (a pause between them), then
    // plain polls on the schedule: never a tight loop.
    expect(urls.slice(0, 2).map(waitParam)).toEqual(["20000", "20000"]);
    expect(urls.slice(2).every(u => waitParam(u) === undefined)).toBe(true);
    expect(sleeps[0]).toBe(1_000);
    expect(sleeps.length).toBe(urls.length - 1);
    expect(sleeps.every(ms => ms >= 250)).toBe(true);
    expect(seenAtMs).toBeGreaterThanOrEqual(4_000);
    expect(
      await counterValue(firePdfAsyncLongPollTotal, { outcome: "not_held" }),
    ).toBe(before + 2);
  });

  it("keeps long-polling after a single early answer", async () => {
    const { sleeps, urls, seenAtMs } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 30_000,
      holding: i => i !== 0,
    });
    // Early answer, one floor pause, then held long-polls to completion.
    expect(urls.every(u => waitParam(u) === "20000")).toBe(true);
    expect(sleeps).toEqual([1_000]);
    expect(seenAtMs).toBe(30_000);
  });

  it("sizes the wait after the pause that follows an early answer", async () => {
    const { urls, sleeps } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 5_000,
      holding: i => i !== 0,
      pollingDeadline: T0 + 10_000,
    });
    // 9s left at the first request; after the 1s pause, 8s.
    expect(urls.map(waitParam)).toEqual(["9000", "8000"]);
    expect(sleeps).toEqual([1_000]);
  });

  it("skips the early-answer pause when no long-poll fits after it", async () => {
    const { urls, sleeps, seenAtMs } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 1_000,
      holding: false,
      pollingDeadline: T0 + 2_500,
    });
    // 2.5s left: after the early answer a 1s pause would leave too little
    // for another long-poll, so that round takes the scheduled path (its
    // sleep, then a plain poll), finishing inside the deadline.
    expect(urls.map(waitParam)).toEqual(["1500", undefined]);
    expect(sleeps).toEqual([1_000]);
    expect(seenAtMs).toBeLessThanOrEqual(2_500);
  });

  it("caps a large retry_after_ms hint in the early-answer pause", async () => {
    let virtualNow = T0;
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: any = async () => {
      calls++;
      return calls >= 2
        ? jsonResp({
            status: 200,
            body: { scrape_id: "x", status: "done", pages_processed: 1 },
          })
        : jsonResp({
            status: 202,
            body: { scrape_id: "x", status: "running", retry_after_ms: 30_000 },
          });
    };
    await pollUntilTerminal({
      baseUrl: "http://fire-pdf.test",
      scrapeId: "x",
      pollingDeadline: DEADLINE,
      meta: makeMeta(),
      fetchImpl,
      sleep: async ms => {
        sleeps.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      random: () => 0,
      longPollWaitMs: 20_000,
    });
    expect(sleeps).toEqual([5_000]);
  });

  it("counts an expired or cancelled answer to a long-poll as terminal", async () => {
    const before = await counterValue(firePdfAsyncLongPollTotal, {
      outcome: "terminal",
    });
    const fetchImpl: any = async () =>
      jsonResp({
        status: 410,
        body: { scrape_id: "x", status: "expired" },
      });
    await expect(
      pollUntilTerminal({
        baseUrl: "http://fire-pdf.test",
        scrapeId: "x",
        pollingDeadline: DEADLINE,
        meta: makeMeta(),
        fetchImpl,
        sleep: async () => {},
        now: () => T0,
        random: () => 0,
        longPollWaitMs: 20_000,
      }),
    ).rejects.toMatchObject({ reason: "terminal_expired" });
    expect(
      await counterValue(firePdfAsyncLongPollTotal, { outcome: "terminal" }),
    ).toBe(before + 1);
  });

  it("bounds the wait by the polling deadline", async () => {
    const { urls } = await runLongPoll({
      longPollWaitMs: 20_000,
      doneAtMs: 3_000,
      holding: true,
      pollingDeadline: T0 + 8_000,
    });
    expect(waitParam(urls[0])).toBe("7000");
  });
});
