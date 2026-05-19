import { jest, describe, it, expect, afterAll } from "@jest/globals";

// Mock ioredis entirely to prevent real network connections during unit tests
jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => {
    return {
      status: "ready",
      connect: jest.fn<any>().mockResolvedValue(undefined),
      quit: jest.fn<any>().mockResolvedValue(undefined),
      disconnect: jest.fn<any>().mockResolvedValue(undefined),
      del: jest.fn<any>().mockResolvedValue(1),
      defineCommand: jest.fn() as any,
    } as any;
  });
});

import { getRateLimiter, redisRateLimitClient } from "./rate-limiter";
import { RateLimiterMode } from "../types";

describe("Rate Limiter Service", () => {
  afterAll(async () => {
    await redisRateLimitClient.quit();
  });

  it("should return the correct rate limiter based on mode and custom rate limits", () => {
    const limiter = getRateLimiter(
      "crawl" as RateLimiterMode,
      { crawl: 50 } as any,
    );
    expect(limiter.points).toBe(50);
  });

  it("should fall back to default rate limits when no custom rate limits are provided", () => {
    const limiter = getRateLimiter("crawl" as RateLimiterMode, null);
    expect(limiter.points).toBe(15);
  });

  it("should enforce a minimum rate limit of 100 for scrape mode", () => {
    const limiter = getRateLimiter(
      "scrape" as RateLimiterMode,
      { scrape: 10 } as any,
    );
    expect(limiter.points).toBe(100);
  });

  it("should consume points correctly", async () => {
    const limiter = getRateLimiter(
      "crawl" as RateLimiterMode,
      { crawl: 15 } as any,
    );
    const key = "test:someToken";

    // Spy on the consume method to test it hermetically
    jest.spyOn(limiter, "consume").mockResolvedValue({
      remainingPoints: 14,
      msBeforeNext: 0,
      consumedPoints: 1,
      isFirstInDuration: true,
    } as any);

    const res = await limiter.consume(key, 1);
    expect(res.remainingPoints).toBe(14);
  });
});
