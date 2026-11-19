import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withCommandTimeout } from "../redis-timeout";

describe("withCommandTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the answer when it arrives in time", async () => {
    const command = new Promise<number>(resolve => setTimeout(resolve, 10, 7));

    const result = withCommandTimeout(command, 1000);
    await vi.advanceTimersByTimeAsync(10);

    expect(await result).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the command's own error through", async () => {
    await expect(
      withCommandTimeout(Promise.reject(new Error("READONLY")), 1000),
    ).rejects.toThrow("READONLY");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the ioredis timeout error when no answer comes", async () => {
    const result = withCommandTimeout(new Promise(() => {}), 1000);
    const assertion = expect(result).rejects.toThrow("Command timed out");
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });

  it("ignores an answer or an error that arrives after it gave up", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const late = new Promise((_, reject) =>
        setTimeout(reject, 2000, new Error("late")),
      );

      const result = withCommandTimeout(late, 1000);
      const assertion = expect(result).rejects.toThrow("Command timed out");
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
      // Let a rejection with no handler surface before checking for one.
      vi.useRealTimers();
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });
});
