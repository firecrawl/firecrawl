import { beforeEach, describe, expect, it, vi } from "vitest";

// The limiter classes are hoisted so every re-import of the module under
// test (vi.resetModules below) sees the same class identities; the
// `instanceof RateLimiterRes` check in refresh-budget depends on that.
const { consume, RateLimiterRedis, RateLimiterRes } = vi.hoisted(() => {
  const consume = vi.fn();
  class RateLimiterRes {}
  class RateLimiterRedis {
    consume = consume;
  }
  return { consume, RateLimiterRedis, RateLimiterRes };
});

vi.mock("rate-limiter-flexible", () => ({ RateLimiterRedis, RateLimiterRes }));

vi.mock("../../../../../services/rate-limiter", () => ({
  redisRateLimitClient: {},
}));

type Budget = typeof import("../fire-pdf/refresh-budget");

describe("refresh budget", () => {
  let budget: Budget;

  beforeEach(async () => {
    consume.mockReset();
    consume.mockResolvedValue(undefined);
    // A fresh module per test: the remembered decisions are module state,
    // so no test can read what an earlier one left behind.
    vi.resetModules();
    budget = await import("../fire-pdf/refresh-budget.js");
  });

  it("spends one token per request and remembers the decision", async () => {
    await expect(budget.consumeRefresh("team-a", "scrape-1")).resolves.toBe(
      "allowed",
    );
    await expect(budget.consumeRefresh("team-a", "scrape-1")).resolves.toBe(
      "allowed",
    );
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledWith("team-a", 1);
    expect(budget.refreshDecisionFor("scrape-1")).toBe("allowed");
  });

  it("starts every test without remembered decisions", () => {
    expect(budget.refreshDecisionFor("scrape-1")).toBeUndefined();
  });

  it("decides each request separately", async () => {
    await budget.consumeRefresh("team-a", "scrape-1");
    await budget.consumeRefresh("team-a", "scrape-2");
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("keeps a denied decision for the same request too", async () => {
    consume.mockRejectedValueOnce(new RateLimiterRes());
    await expect(budget.consumeRefresh("team-b", "scrape-1")).resolves.toBe(
      "limited",
    );
    // A later engine on the same request sees the same answer without
    // asking the limiter again.
    await expect(budget.consumeRefresh("team-b", "scrape-1")).resolves.toBe(
      "limited",
    );
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("reports the limiter store being unreachable as unavailable", async () => {
    consume.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(budget.consumeRefresh("team-c", "scrape-1")).resolves.toBe(
      "unavailable",
    );
  });

  it("decides afresh without a scrape id and knows nothing about unknown ids", async () => {
    await budget.consumeRefresh("team-d");
    await budget.consumeRefresh("team-d");
    expect(consume).toHaveBeenCalledTimes(2);
    expect(budget.refreshDecisionFor("never-seen")).toBeUndefined();
    expect(budget.refreshDecisionFor(undefined)).toBeUndefined();
  });
});
