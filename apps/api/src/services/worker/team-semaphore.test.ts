import { vi } from "vitest";

const controls = vi.hoisted(() => ({
  reserveResults: [] as (boolean | Error)[],
  renewResult: true as boolean | Error | Promise<boolean>,
  reserve: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
  redisScript: vi.fn(),
}));

vi.mock("../../lib/deployment", () => ({ isSelfHosted: vi.fn(() => false) }));
vi.mock("../../lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("./nuq-router", () => ({
  reserveExternalSlot: controls.reserve.mockImplementation(async () => {
    const result = controls.reserveResults.shift();
    if (result instanceof Error) throw result;
    return result ?? true;
  }),
  renewExternalSlot: controls.renew.mockImplementation(async () => {
    if (controls.renewResult instanceof Error) throw controls.renewResult;
    return await controls.renewResult;
  }),
  mirrorExternalSlotRelease: controls.release.mockResolvedValue(undefined),
}));
vi.mock("./redis", () => ({
  semaphoreKeys: (teamId: string) => ({ leases: `leases:${teamId}` }),
  nuqRedis: {
    scripts: {
      semaphore: {
        acquire: "acquire",
        heartbeat: "heartbeat",
        release: "release",
      },
    },
    ensure: vi.fn(),
    runScript: controls.redisScript,
    zcard: vi.fn(),
  },
}));

import { teamConcurrencySemaphore } from "./team-semaphore";

describe("team semaphore authoritative routed capacity", () => {
  beforeEach(() => {
    controls.reserveResults = [];
    controls.renewResult = true;
    controls.reserve.mockClear();
    controls.renew.mockClear();
    controls.release.mockClear();
    controls.redisScript.mockClear();
  });

  test("fails closed when durable holder renewal fails", async () => {
    const renewalError = new Error("FDB renewal unavailable");
    controls.reserveResults = [true];
    controls.renewResult = renewalError;

    let callbackAborted = false;
    let sideEffectAfterAbort = false;
    const work = teamConcurrencySemaphore.withSemaphore(
      "team",
      "holder",
      1,
      new AbortController().signal,
      1_000,
      async (_limited, signal) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              callbackAborted = true;
              queueMicrotask(() => {
                if (!signal.aborted) sideEffectAfterAbort = true;
              });
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );

    await expect(work).rejects.toBe(renewalError);
    await Promise.resolve();
    expect(callbackAborted).toBe(true);
    expect(sideEffectAfterAbort).toBe(false);
    expect(controls.reserve).toHaveBeenCalledTimes(1);
    expect(controls.renew).toHaveBeenCalledTimes(1);
    expect(controls.release).toHaveBeenCalledWith("team", "holder");
    expect(controls.redisScript).not.toHaveBeenCalled();
  });

  test("aborts protected work when an authoritative renewal hangs", async () => {
    vi.useFakeTimers();
    try {
      controls.reserveResults = [true];
      controls.renewResult = new Promise<boolean>(() => {});
      let callbackAborted = false;
      const work = teamConcurrencySemaphore.withSemaphore(
        "team",
        "hung-renewal",
        1,
        new AbortController().signal,
        60_000,
        async (_limited, signal) =>
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                callbackAborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const rejection = expect(work).rejects.toMatchObject({
        code: "SCRAPE_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;
      expect(callbackAborted).toBe(true);
      expect(controls.release).toHaveBeenCalledWith("team", "hung-renewal");
    } finally {
      vi.useRealTimers();
    }
  });

  test("retries the authoritative reservation and reports capacity limiting", async () => {
    vi.useFakeTimers();
    try {
      controls.reserveResults = [false, true];
      const work = teamConcurrencySemaphore.withSemaphore(
        "team",
        "holder",
        1,
        new AbortController().signal,
        1_000,
        async limited => limited,
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(work).resolves.toBe(true);
      expect(controls.reserve).toHaveBeenCalledTimes(2);
      expect(controls.renew).toHaveBeenCalledTimes(1);
      expect(controls.redisScript).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("releases a reservation that succeeds after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveReservation!: (reserved: boolean) => void;
      controls.reserve.mockImplementationOnce(
        async () =>
          await new Promise<boolean>(resolve => {
            resolveReservation = resolve;
          }),
      );
      const func = vi.fn();
      const work = teamConcurrencySemaphore.withSemaphore(
        "team",
        "late-holder",
        1,
        new AbortController().signal,
        100,
        func,
      );
      const rejection = expect(work).rejects.toMatchObject({
        code: "SCRAPE_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(101);
      resolveReservation(true);
      await rejection;
      expect(func).not.toHaveBeenCalled();
      expect(controls.release).toHaveBeenCalledWith("team", "late-holder");
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not release or start work when reservation times out", async () => {
    vi.useFakeTimers();
    try {
      controls.reserveResults = Array(20).fill(false);
      const func = vi.fn();
      const work = teamConcurrencySemaphore.withSemaphore(
        "team",
        "holder",
        1,
        new AbortController().signal,
        100,
        func,
      );
      const rejection = expect(work).rejects.toMatchObject({
        code: "SCRAPE_TIMEOUT",
      });

      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(func).not.toHaveBeenCalled();
      expect(controls.release).not.toHaveBeenCalled();
      expect(controls.redisScript).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
