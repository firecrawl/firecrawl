import { describe, expect, it, vi } from "vitest";
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
  it("returns an empty list when every check passes", async () => {
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      ["postgres", async () => undefined],
    ]);
    expect(failed).toEqual([]);
  });

  it("names each failing check", async () => {
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      [
        "postgres",
        async () => {
          throw new Error("connection refused");
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
  });

  it("skips null checks so unconfigured deps are not required", async () => {
    const failed = await collectUnhealthy([
      ["queueRedis", async () => undefined],
      ["postgres", null],
    ]);
    expect(failed).toEqual([]);
  });
});
