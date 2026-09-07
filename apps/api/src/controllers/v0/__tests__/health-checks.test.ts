import { beforeEach, describe, expect, it, vi } from "vitest";

const { logger } = vi.hoisted(() => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../../lib/logger", () => ({ logger }));

import { collectUnhealthy, pingIfReady, redisEnded } from "../health-checks";

describe("redisEnded", () => {
  it("is true only for status end", () => {
    expect(redisEnded({ status: "end", ping: vi.fn() })).toBe(true);
    expect(redisEnded({ status: "ready", ping: vi.fn() })).toBe(false);
    expect(redisEnded({ status: "reconnecting", ping: vi.fn() })).toBe(false);
    expect(redisEnded(null)).toBe(false);
  });
});

describe("pingIfReady", () => {
  it("pings a ready client", async () => {
    const ping = vi.fn().mockResolvedValue("PONG");
    await pingIfReady({ status: "ready", ping })();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("does not ping when the client is reconnecting", async () => {
    const ping = vi.fn();
    await expect(
      pingIfReady({ status: "reconnecting", ping })(),
    ).rejects.toThrow(/not ready/);
    expect(ping).not.toHaveBeenCalled();
  });
});

describe("collectUnhealthy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty list when every check passes", async () => {
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      ["postgres", async () => undefined],
    ]);
    expect(failed).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names each failing check and logs the error", async () => {
    const pgErr = new Error("connection refused");
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      [
        "postgres",
        async () => {
          throw pgErr;
        },
      ],
      [
        "nuqPostgres",
        async () => {
          throw new Error("timeout");
        },
      ],
    ]);
    expect(failed).toEqual(["postgres", "nuqPostgres"]);
    expect(logger.warn).toHaveBeenCalledWith("Readiness check failed", {
      module: "health",
      check: "postgres",
      error: pgErr,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Readiness check failed",
      expect.objectContaining({ check: "nuqPostgres" }),
    );
  });

  it("skips null checks so unconfigured deps are not required", async () => {
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      ["postgres", null],
    ]);
    expect(failed).toEqual([]);
  });
});
