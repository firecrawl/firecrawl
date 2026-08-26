import { describe, test, expect, jest } from "@jest/globals";
import { waitForBatchCompletion } from "../../../v2/methods/batch";
import { JobFailedError } from "../../../v2/types";

describe("waitForBatchCompletion terminal handling", () => {
  function makeHttp(responses: any[]) {
    let i = 0;
    return { get: jest.fn(async () => responses[Math.min(i++, responses.length - 1)]) } as any;
  }

  test("returns the job when it completes", async () => {
    const scraping = { status: 200, data: { success: true, status: "scraping", completed: 1, total: 2, next: null, data: [] } };
    const completed = { status: 200, data: { success: true, status: "completed", completed: 2, total: 2, next: null, data: [{ markdown: "a" }, { markdown: "b" }] } };
    const http = makeHttp([scraping, completed]);
    const job = await waitForBatchCompletion(http, "job1", 1);
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
});
