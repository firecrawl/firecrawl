const redis = vi.hoisted(() => ({ set: vi.fn(), eval: vi.fn() }));
const warn = vi.hoisted(() => vi.fn());

vi.mock("uuid", () => ({ v7: () => "lease-token" }));
vi.mock("../../lib/logger", () => ({
  logger: { child: () => ({ warn }) },
}));
vi.mock("../redis", () => ({ redisEvictConnection: redis }));

import { acquireMonitorCheckFinalizeLease } from "./finalize-lease";

describe("monitor check finalize lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    redis.set.mockResolvedValue("OK");
  });

  afterEach(() => vi.useRealTimers());

  it.each([
    { name: "is no longer owned", renew: () => Promise.resolve(0) },
    {
      name: "cannot be renewed",
      renew: () => Promise.reject(new Error("Redis unavailable")),
    },
  ])("aborts when the lease $name", async ({ renew }) => {
    redis.eval.mockImplementationOnce(renew);
    const lease = await acquireMonitorCheckFinalizeLease("check-1");

    await vi.advanceTimersByTimeAsync(20_000);

    expect(lease?.signal.aborted).toBe(true);
    await lease?.release();
  });

  it("aborts when lease renewal never settles", async () => {
    redis.eval
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(1);
    const lease = await acquireMonitorCheckFinalizeLease("check-1");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lease?.signal.aborted).toBe(true);
    await lease?.release();
  });

  it("swallows and logs lease release failures", async () => {
    const lease = await acquireMonitorCheckFinalizeLease("check-1");
    redis.eval.mockRejectedValueOnce(new Error("Redis unavailable"));

    await expect(lease?.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Failed to release monitor finalize lease",
      expect.objectContaining({ checkId: "check-1" }),
    );
  });
});
