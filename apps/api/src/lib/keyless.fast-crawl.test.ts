import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/rate-limiter", () => ({
  redisRateLimitClient: {
    incr: vi.fn(async () => 1_000_000),
    expire: vi.fn(async () => {}),
    get: vi.fn(async () => "1000000"),
    eval: vi.fn(async () => [0, 1000000]),
    ttl: vi.fn(async () => 42),
  },
}));
import { config } from "../config";
import {
  consumeKeylessRequest,
  reserveKeylessCredits,
} from "./keyless";
import { redisRateLimitClient } from "../services/rate-limiter";

describe("keyless quotas under FAST_CRAWL", () => {
  afterEach(() => {
    delete (config as any).FAST_CRAWL;
    vi.restoreAllMocks();
  });

  it("consumeKeylessRequest bypasses exhausted budgets when FAST_CRAWL is set", async () => {
    (config as any).FAST_CRAWL = true;
    const result = await consumeKeylessRequest("203.0.113.8");
    expect(result.ok).toBe(true);
    // The gate must short-circuit before touching the quota counters.
    expect(redisRateLimitClient.incr).not.toHaveBeenCalled();
    expect(redisRateLimitClient.get).not.toHaveBeenCalled();
  });

  it("consumeKeylessRequest still enforces budgets when FAST_CRAWL is unset", async () => {
    // With no KEYLESS_* env configured the limits are 0, so any consumption
    // is over budget: the pre-gate path must still report failure.
    const result = await consumeKeylessRequest("203.0.113.8");
    expect(result.ok).toBe(false);
    expect(redisRateLimitClient.incr).toHaveBeenCalled();
  });

  it("reserveKeylessCredits never fails on budget when FAST_CRAWL is set", async () => {
    (config as any).FAST_CRAWL = true;
    const result = await reserveKeylessCredits(
      "preview_keyless_203.0.113.8",
      999_999,
    );
    expect(result.ok).toBe(true);
    expect(redisRateLimitClient.eval).not.toHaveBeenCalled();
  });
});
