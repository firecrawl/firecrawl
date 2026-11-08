import { describe, expect, jest, test } from "@jest/globals";
import { waitAgent } from "../../../v2/methods/agent";
import { JobTimeoutError } from "../../../v2/types";

describe("v2.agent timeout", () => {
  test("reports an unfinished agent job with its ID after the timeout", async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date("2026-09-28T00:00:00.000Z"));
      const get = jest.fn(async () => {
        jest.setSystemTime(new Date("2026-09-28T00:00:01.000Z"));
        return {
          status: 200,
          data: {
            success: true,
            status: "processing",
            expiresAt: "2026-09-29T00:00:00.000Z",
          },
        };
      });

      await expect(waitAgent({ get } as any, "agent-job-123", 1, 0.5)).rejects.toMatchObject({
        name: "JobTimeoutError",
        code: "JOB_TIMEOUT",
        jobId: "agent-job-123",
        timeoutSeconds: 0.5,
      } satisfies Partial<JobTimeoutError>);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
