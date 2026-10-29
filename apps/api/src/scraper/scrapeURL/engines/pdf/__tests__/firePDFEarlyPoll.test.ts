import { earlyPollDelay } from "../fire-pdf/early-poll";
import { pollUntilTerminal } from "../fire-pdf/poll";
import { jsonResp, makeMeta } from "./firePDFAsyncFixtures";

const T0 = 1_000_000;

// Drives pollUntilTerminal on a virtual clock. The job is `running` until
// `doneAtMs` of virtual time has passed (or `doneAfterPolls` polls were
// served), and `runningBody` is what every running poll answers with.
async function runPoll(opts: {
  pagesEstimate?: number;
  initialDelay?: number;
  doneAtMs?: number;
  doneAfterPolls?: number;
  jobDeadlineAtMs?: number;
  runningBody?: Record<string, unknown>;
}) {
  let virtualNow = T0;
  const sleeps: number[] = [];
  let polls = 0;
  const fetchImpl: any = async () => {
    polls++;
    const done =
      (opts.doneAtMs !== undefined && virtualNow - T0 >= opts.doneAtMs) ||
      (opts.doneAfterPolls !== undefined && polls >= opts.doneAfterPolls);
    return done
      ? jsonResp({
          status: 200,
          body: { scrape_id: "x", status: "done", pages_processed: 1 },
        })
      : jsonResp({
          status: 202,
          body: {
            scrape_id: "x",
            status: "running",
            ...opts.runningBody,
          },
        });
  };
  const result = await pollUntilTerminal({
    baseUrl: "http://fire-pdf.test",
    scrapeId: "x",
    initialDelay: opts.initialDelay,
    pagesEstimate: opts.pagesEstimate,
    pollingDeadline: T0 + 10 * 60_000,
    meta: makeMeta(),
    fetchImpl,
    sleep: async ms => {
      sleeps.push(ms);
      virtualNow += ms;
    },
    now: () => virtualNow,
    random: () => 0,
    jobDeadlineAtMs:
      opts.jobDeadlineAtMs !== undefined
        ? T0 + opts.jobDeadlineAtMs
        : undefined,
  });
  return { sleeps, pollCount: result.pollCount };
}

const repeat = (ms: number, n: number) => Array<number>(n).fill(ms);

describe("pollUntilTerminal — page-aware early polling", () => {
  it("polls a small document at its expected finish time, then every ~300ms through the slow tail", async () => {
    // 3 pages: first poll at 1.2s, fast polls while under 5s (the 13th
    // lands at 5.1s), then the regular backoff from its 1s floor.
    const { sleeps, pollCount } = await runPoll({
      pagesEstimate: 3,
      doneAtMs: 6_000,
    });
    expect(sleeps).toEqual([1200, ...repeat(300, 13), 1000]);
    expect(pollCount).toBe(15);
  });

  it("sees a job that finishes at the expected time on the very first poll", async () => {
    const { sleeps, pollCount } = await runPoll({
      pagesEstimate: 1,
      doneAtMs: 1_000,
    });
    expect(sleeps).toEqual([1000]);
    expect(pollCount).toBe(1);
  });

  it("falls back to the doubling backoff, capped at 5s, once past the slow tail", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      doneAtMs: 30_000,
    });
    const afterTail = sleeps.slice(1 + 13);
    expect(afterTail.slice(0, 6)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("keeps today's schedule when there is no page estimate", async () => {
    const { sleeps } = await runPoll({ doneAfterPolls: 7 });
    expect(sleeps).toEqual([1000, 2000, 4000, 5000, 5000, 5000, 5000]);
  });

  it("keeps today's schedule for a document larger than the bucket table", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 400,
      doneAfterPolls: 7,
    });
    expect(sleeps).toEqual([1000, 2000, 4000, 5000, 5000, 5000, 5000]);
  });

  it("lets fire-pdf's retry_after_ms win over the early schedule when it is larger", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      initialDelay: 2_000,
      doneAfterPolls: 3,
      runningBody: { retry_after_ms: 1_500 },
    });
    // First poll waits for the submit response's hint (2s > the 1.2s p50);
    // each running poll then asks for 1.5s, which beats the 300ms tick.
    expect(sleeps).toEqual([2000, 1500, 1500]);
  });

  it("caps a very large retry_after_ms at the regular poll cap", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      initialDelay: 30_000,
      doneAfterPolls: 2,
      runningBody: { retry_after_ms: 30_000 },
    });
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("restarts the backoff from the floor at handover, whatever the submit hint was", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      initialDelay: 30_000,
      doneAfterPolls: 3,
    });
    expect(sleeps).toEqual([5000, 1000, 2000]);
  });

  it("ignores a retry_after_ms smaller than the early schedule", async () => {
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      initialDelay: 100,
      doneAfterPolls: 3,
      runningBody: { retry_after_ms: 50 },
    });
    expect(sleeps).toEqual([1200, 300, 300]);
  });

  it("caps the number of fast polls per job, however long the slow tail", async () => {
    // 100 pages: p50 11.8s, p90 31s. 30 fast polls only span ~9s of that
    // window, so the cap — not p90 — hands over to the backoff.
    const { sleeps } = await runPoll({
      pagesEstimate: 100,
      doneAfterPolls: 40,
    });
    expect(sleeps[0]).toBe(11_800);
    expect(sleeps.slice(1, 31)).toEqual(repeat(300, 30));
    expect(sleeps.slice(31, 37)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it("still pulls polls in to land just after the job deadline, past the slow tail", async () => {
    // 3 pages with an 8s job deadline: the early schedule ends at 5.1s,
    // backoff runs 1s (6.1s) and 2s (8.1s); the next 4s sleep would
    // overshoot deadline + 1s grace (9s), so it is cut to the 1s floor and
    // polling stays at the floor after the deadline.
    const { sleeps } = await runPoll({
      pagesEstimate: 3,
      jobDeadlineAtMs: 8_000,
      doneAfterPolls: 20,
    });
    expect(sleeps.slice(14, 18)).toEqual([1000, 2000, 1000, 1000]);
  });
});

describe("earlyPollDelay", () => {
  const base = {
    elapsedMs: 0,
    pollCount: 0,
    fastPollCount: 0,
    retryAfterMs: undefined,
    random: () => 0,
  };

  it("applies +0-20% jitter to the ~300ms fast interval", () => {
    const delays = [0, 0.5, 0.999].map(random =>
      earlyPollDelay({
        ...base,
        pagesEstimate: 10,
        pollCount: 3,
        elapsedMs: 4_000,
        random: () => random,
      }),
    );
    expect(delays).toEqual([300, 330, 360]);
  });

  it("picks the bucket from the page estimate", () => {
    const first = (pages: number) =>
      earlyPollDelay({ ...base, pagesEstimate: pages });
    expect(first(1)).toBe(1000);
    expect(first(5)).toBe(1200);
    expect(first(6)).toBe(2500);
    expect(first(25)).toBe(4400);
    expect(first(50)).toBe(5200);
    expect(first(100)).toBe(11_800);
  });

  it("declines without a usable estimate or beyond the table", () => {
    expect(earlyPollDelay({ ...base, pagesEstimate: undefined })).toBe(
      undefined,
    );
    expect(earlyPollDelay({ ...base, pagesEstimate: 0 })).toBe(undefined);
    expect(earlyPollDelay({ ...base, pagesEstimate: NaN })).toBe(undefined);
    expect(earlyPollDelay({ ...base, pagesEstimate: 101 })).toBe(undefined);
  });
});
