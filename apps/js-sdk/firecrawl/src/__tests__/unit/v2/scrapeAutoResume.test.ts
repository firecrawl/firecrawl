import { describe, expect, test } from "@jest/globals";
import {
  processingContinuesDelayMs,
  scrape,
} from "../../../v2/methods/scrape";

const DOC = { markdown: "# big doc" };

function processingContinues408(retryAfterSeconds = 10) {
  return {
    isAxiosError: true,
    response: {
      status: 408,
      headers: { "retry-after": String(retryAfterSeconds) },
      data: {
        success: false,
        code: "SCRAPE_TIMEOUT",
        error: "Request timed out, but this 700-page PDF is still being processed on our side.",
        details: {
          state: "processing_continues",
          documentPages: 700,
          jobStatus: "running",
          estimatedRemainingSeconds: retryAfterSeconds,
          retryAfterSeconds,
        },
      },
    },
  };
}

describe("v2.scrape auto-resume", () => {
  test("resumes after processing_continues and returns the finished document", async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(processingContinues408(10))
      .mockResolvedValueOnce({ status: 200, data: { success: true, data: DOC } });
    const sleeps: number[] = [];
    const sleepImpl = async (ms: number) => {
      sleeps.push(ms);
    };

    const doc = await scrape({ post } as any, "https://example.com/big.pdf", undefined, {
      sleepImpl,
    });

    expect(doc).toEqual(DOC);
    expect(post).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([10_000]);
  });

  test("autoResume: false surfaces the timeout immediately and never sleeps", async () => {
    const post = jest.fn().mockRejectedValueOnce(processingContinues408());
    const sleepImpl = jest.fn();

    await expect(
      scrape({ post } as any, "https://example.com/big.pdf", { autoResume: false }, {
        sleepImpl: sleepImpl as any,
      }),
    ).rejects.toBeDefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("autoResume never enters the wire payload", async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, data: { success: true, data: DOC } });
    await scrape({ post } as any, "https://example.com/x", { autoResume: true });
    const payload = post.mock.calls[0][1];
    expect(payload).toEqual({ url: "https://example.com/x" });
  });

  test("gives up after the attempt bound and surfaces the error", async () => {
    const post = jest.fn().mockRejectedValue(processingContinues408(10));
    const sleepImpl = jest.fn().mockResolvedValue(undefined);

    await expect(
      scrape({ post } as any, "https://example.com/big.pdf", undefined, {
        sleepImpl: sleepImpl as any,
      }),
    ).rejects.toBeDefined();
    // 1 initial + 5 resumes.
    expect(post).toHaveBeenCalledTimes(6);
    expect(sleepImpl).toHaveBeenCalledTimes(5);
  });

  test("plain timeouts without the processing signal do not resume", async () => {
    const post = jest.fn().mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 408,
        headers: {},
        data: { success: false, code: "SCRAPE_TIMEOUT", error: "Request timed out" },
      },
    });
    const sleepImpl = jest.fn();

    await expect(
      scrape({ post } as any, "https://example.com/slow", undefined, {
        sleepImpl: sleepImpl as any,
      }),
    ).rejects.toBeDefined();
    expect(post).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  test("processingContinuesDelayMs clamps and falls back sensibly", () => {
    expect(processingContinuesDelayMs(processingContinues408(1))).toBe(5_000);
    expect(processingContinuesDelayMs(processingContinues408(3_600))).toBe(600_000);
    // No payload field → Retry-After header.
    const headerOnly = processingContinues408(0);
    delete (headerOnly.response.data.details as any).retryAfterSeconds;
    headerOnly.response.headers["retry-after"] = "90";
    expect(processingContinuesDelayMs(headerOnly)).toBe(90_000);
    expect(processingContinuesDelayMs(new Error("net"))).toBeUndefined();
    expect(processingContinuesDelayMs(undefined)).toBeUndefined();
  });
});
