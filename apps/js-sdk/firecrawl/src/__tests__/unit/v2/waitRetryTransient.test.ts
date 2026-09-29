import { describe, test, expect, jest } from "@jest/globals";
import { SdkError } from "../../../v2/types";
import { isRetryableError } from "../../../v2/utils/errorHandler";
import { waitForCrawlCompletion } from "../../../v2/methods/crawl";
import { waitForBatchCompletion } from "../../../v2/methods/batch";

function axiosStatusError(status: number, message: string) {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    response: { status, data: { success: false, error: message } },
  });
}

describe("v2 job waiters: transient 4xx responses", () => {
  test("isRetryableError treats 408 and 429 as retryable and other 4xx as permanent", () => {
    expect(isRetryableError(new SdkError("rate limited", 429))).toBe(true);
    expect(isRetryableError(new SdkError("timeout", 408))).toBe(true);
    expect(isRetryableError(new SdkError("not found", 404))).toBe(false);
    expect(isRetryableError(new SdkError("unauthorized", 401))).toBe(false);
  });

  test("waitForCrawlCompletion keeps polling after a 429 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValueOnce(axiosStatusError(429, "Rate limit exceeded"))
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, status: "completed", completed: 1, total: 1, data: [] },
      });

    const job = await waitForCrawlCompletion({ get } as any, "job-1", 1);

    expect(job.status).toBe("completed");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("waitForBatchCompletion keeps polling after a 429 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValueOnce(axiosStatusError(429, "Rate limit exceeded"))
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, status: "completed", completed: 1, total: 1, data: [] },
      });

    const job = await waitForBatchCompletion({ get } as any, "job-2", 1);

    expect(job.status).toBe("completed");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("waitForCrawlCompletion keeps polling after a 408 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValueOnce(axiosStatusError(408, "Request timeout"))
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, status: "completed", completed: 1, total: 1, data: [] },
      });

    const job = await waitForCrawlCompletion({ get } as any, "job-4", 1);

    expect(job.status).toBe("completed");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("waitForBatchCompletion keeps polling after a 408 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValueOnce(axiosStatusError(408, "Request timeout"))
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true, status: "completed", completed: 1, total: 1, data: [] },
      });

    const job = await waitForBatchCompletion({ get } as any, "job-5", 1);

    expect(job.status).toBe("completed");
    expect(get).toHaveBeenCalledTimes(2);
  });

  test("waitForCrawlCompletion still fails fast on a 404 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValue(axiosStatusError(404, "Job not found"));

    const err = await waitForCrawlCompletion({ get } as any, "job-3", 1).catch((e) => e);

    expect(err).toBeInstanceOf(SdkError);
    expect(err.message).toMatch(/Job not found/);
    expect(err.status).toBe(404);
    expect(err.jobId).toBe("job-3");
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("waitForBatchCompletion still fails fast on a 404 status response", async () => {
    const get = jest
      .fn<(url: string) => Promise<any>>()
      .mockRejectedValue(axiosStatusError(404, "Job not found"));

    const err = await waitForBatchCompletion({ get } as any, "job-6", 1).catch((e) => e);

    expect(err).toBeInstanceOf(SdkError);
    expect(err.message).toMatch(/Job not found/);
    expect(err.status).toBe(404);
    expect(err.jobId).toBe("job-6");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
