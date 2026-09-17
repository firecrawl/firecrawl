import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiterRes } from "rate-limiter-flexible";
import { consumeRefresh, refreshDecisionFor } from "../fire-pdf/refresh-budget";

const { consume } = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock("rate-limiter-flexible", () => {
  class RateLimiterRes {}
  class RateLimiterRedis {
    consume = consume;
  }
  return { RateLimiterRedis, RateLimiterRes };
});

vi.mock("../../../../../services/rate-limiter", () => ({
  redisRateLimitClient: {},
}));

describe("refresh budget", () => {
  beforeEach(() => {
    consume.mockReset();
    consume.mockResolvedValue(undefined);
  });

  it("spends one token per request and remembers the decision", async () => {
    await expect(consumeRefresh("team-a", "scrape-1")).resolves.toBe("allowed");
    await expect(consumeRefresh("team-a", "scrape-1")).resolves.toBe("allowed");
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith("team-a", 1);
    expect(refreshDecisionFor("scrape-1")).toBe("allowed");
  });

  it("decides each request separately", async () => {
    await consumeRefresh("team-a", "scrape-2");
    await consumeRefresh("team-a", "scrape-3");
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("keeps a denied decision for the same request too", async () => {
    consume.mockRejectedValueOnce(new RateLimiterRes());
    await expect(consumeRefresh("team-b", "scrape-4")).resolves.toBe("limited");
    // A later engine on the same request sees the same answer without
    // asking the limiter again.
    await expect(consumeRefresh("team-b", "scrape-4")).resolves.toBe("limited");
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("reports the limiter store being unreachable as unavailable", async () => {
    consume.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(consumeRefresh("team-c", "scrape-5")).resolves.toBe(
      "unavailable",
    );
  });

  it("decides afresh without a scrape id and knows nothing about unknown ids", async () => {
    await consumeRefresh("team-d");
    await consumeRefresh("team-d");
    expect(consume).toHaveBeenCalledTimes(2);
    expect(refreshDecisionFor("never-seen")).toBeUndefined();
    expect(refreshDecisionFor(undefined)).toBeUndefined();
  });
});
