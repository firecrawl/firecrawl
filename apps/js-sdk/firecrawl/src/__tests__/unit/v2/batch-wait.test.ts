import { describe, test, expect, jest, afterEach } from "@jest/globals";
import { waitForBatchCompletion } from "../../../v2/methods/batch";
import { JobFailedError } from "../../../v2/types";

describe("waitForBatchCompletion terminal handling", () => {
  function makeHttp(responses: any[]) {
    let i = 0;
    return { get: jest.fn(async () => responses[Math.min(i++, responses.length - 1)]) } as any;
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns the job when it completes", async () => {
    // Fake timers avoid the real 1s poll-interval sleep between the scraping and completed polls.
    jest.useFakeTimers();
    const scraping = { status: 200, data: { success: true, status: "scraping", completed: 1, total: 2, next: null, data: [] } };
    const completed = { status: 200, data: { success: true, status: "completed", completed: 2, total: 2, next: null, data: [{ markdown: "a" }, { markdown: "b" }] } };
    const http = makeHttp([scraping, completed]);
    const jobPromise = waitForBatchCompletion(http, "job1", 1);
    await jest.advanceTimersByTimeAsync(1000);
    const job = await jobPromise;
    expect(job.status).toBe("completed");
    expect(job.data.length).toBe(2);
  });

  test("throws JobFailedError carrying the job when the batch fails", async () => {
    const failed = { status: 200, data: { success: true, status: "failed", completed: 0, total: 3, next: null, data: [] } };
    const http = makeHttp([failed]);
    const err = await waitForBatchCompletion(http, "job2", 1).then(
      () => { throw new Error("expected JobFailedError"); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(JobFailedError);
    expect(err.job.status).toBe("failed");
    expect(err.jobId).toBe("job2");
  });

  test("throws JobFailedError when the batch is cancelled", async () => {
    const cancelled = { status: 200, data: { success: true, status: "cancelled", completed: 1, total: 3, next: null, data: [] } };
    const http = makeHttp([cancelled]);
    await expect(waitForBatchCompletion(http, "job3", 1)).rejects.toBeInstanceOf(JobFailedError);
  });

  test("rejects instead of looping when a terminal job's pagination page returns success:false", async () => {
    const completed = { status: 200, data: { success: true, status: "completed", completed: 2, total: 2, next: "https://api/next1", data: [{ markdown: "a" }] } };
    const badPage = { status: 200, data: { success: false, error: "boom" } };
    const http = makeHttp([completed, badPage]);
    await expect(waitForBatchCompletion(http, "job4", 1)).rejects.toMatchObject({ code: "PAGINATION_RESPONSE_INVALID" });
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test("throws JobFailedError with the API error string when the job fails during kickoff", async () => {
    const kickoffFailed = { status: 200, data: { success: false, error: "queue full", status: "failed", completed: 0, total: 0, data: [] } };
    const http = makeHttp([kickoffFailed]);
    const err = await waitForBatchCompletion(http, "job5", 1).then(
      () => { throw new Error("expected JobFailedError"); },
      (e) => e,
    );
    expect(err).toBeInstanceOf(JobFailedError);
    expect(err.job.status).toBe("failed");
    expect(err.message).toContain("queue full");
  });
});
