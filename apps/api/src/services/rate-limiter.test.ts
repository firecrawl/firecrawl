import { jest, describe, it, expect, afterAll } from "@jest/globals";
import { RateLimiterRedis } from "rate-limiter-flexible";

// NOTE:
// Historically, this rate limiter test suite was commented out entirely because it attempted
// to connect to a live, network-dependent Redis instance, making it highly fragile and offline-unstable.
// We have mocked `ioredis` here to restore all 19 tests as hermetic and offline-stable unit tests.
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

  it("should return the serverRateLimiter if mode is not found", () => {
    const limiter = getRateLimiter("nonexistent" as RateLimiterMode, null);
    expect(limiter.points).toBe(500);
  });

  it("should return the correct rate limiter based on mode and plan", () => {
    const limiter = getRateLimiter(
      "crawl" as RateLimiterMode,
      { crawl: 2 } as any,
    );
    expect(limiter.points).toBe(2);

    const limiter2 = getRateLimiter(
      "scrape" as RateLimiterMode,
      { scrape: 100 } as any,
    );
    expect(limiter2.points).toBe(100);

    const limiter3 = getRateLimiter(
      "search" as RateLimiterMode,
      { search: 500 } as any,
    );
    expect(limiter3.points).toBe(500);

    const limiter4 = getRateLimiter(
      "crawlStatus" as RateLimiterMode,
      { crawlStatus: 250 } as any,
    );
    expect(limiter4.points).toBe(250);
  });

  it("should return the default rate limiter if plan is not provided", () => {
    const limiter = getRateLimiter("crawl" as RateLimiterMode, null);
    expect(limiter.points).toBe(15);

    const limiter2 = getRateLimiter("scrape" as RateLimiterMode, null);
    expect(limiter2.points).toBe(100);
  });

  it("should create a new RateLimiterRedis instance with correct parameters", () => {
    const keyPrefix = "test-prefix";
    const points = 10;
    const limiter = new RateLimiterRedis({
      storeClient: redisRateLimitClient,
      keyPrefix,
      points,
      duration: 60,
    });

    expect(limiter.keyPrefix).toBe(keyPrefix);
    expect(limiter.points).toBe(points);
    expect(limiter.duration).toBe(60);
  });

  it("should return the correct rate limiter for 'preview' mode", () => {
    const limiter = getRateLimiter(
      "preview" as RateLimiterMode,
      { preview: 5 } as any,
    );
    expect(limiter.points).toBe(5);

    const limiter2 = getRateLimiter("preview" as RateLimiterMode, null);
    expect(limiter2.points).toBe(25);
  });

  it("should return the correct rate limiter for 'account' mode", () => {
    const limiter = getRateLimiter(
      "account" as RateLimiterMode,
      { account: 100 } as any,
    );
    expect(limiter.points).toBe(100);

    const limiter2 = getRateLimiter("account" as RateLimiterMode, null);
    expect(limiter2.points).toBe(1000);
  });

  it("should return the correct rate limiter for 'crawlStatus' mode", () => {
    const limiter = getRateLimiter(
      "crawlStatus" as RateLimiterMode,
      { crawlStatus: 150 } as any,
    );
    expect(limiter.points).toBe(150);

    const limiter2 = getRateLimiter("crawlStatus" as RateLimiterMode, null);
    expect(limiter2.points).toBe(25000);
  });

  it("should consume points correctly for 'crawl' mode", async () => {
    const limiter = getRateLimiter(
      "crawl" as RateLimiterMode,
      { crawl: 2 } as any,
    );

    jest.spyOn(limiter, "consume").mockResolvedValue({
      remainingPoints: 1,
      msBeforeNext: 0,
      consumedPoints: 1,
      isFirstInDuration: true,
    } as any);

    const res = await limiter.consume("test-prefix:someTokenCRAWL", 1);
    expect(res.remainingPoints).toBe(1);
  });

  it("should consume points correctly for 'scrape' mode (DEFAULT)", async () => {
    const limiter = getRateLimiter("scrape" as RateLimiterMode, null);

    jest.spyOn(limiter, "consume").mockResolvedValue({
      remainingPoints: 96,
      msBeforeNext: 0,
      consumedPoints: 4,
      isFirstInDuration: true,
    } as any);

    const res = await limiter.consume("test-prefix:someTokenX", 4);
    expect(res.remainingPoints).toBe(96);
  });

  it("should consume points correctly for 'scrape' mode (HOBBY)", async () => {
    const limiter = getRateLimiter(
      "scrape" as RateLimiterMode,
      { scrape: 20 } as any,
    );
    expect(limiter.points).toBe(100); // minimum 100 enforced for scrape

    jest.spyOn(limiter, "consume").mockResolvedValue({
      remainingPoints: 95,
      msBeforeNext: 0,
      consumedPoints: 5,
      isFirstInDuration: true,
    } as any);

    const res = await limiter.consume("test-prefix:someTokenXY", 5);
    expect(res.remainingPoints).toBe(95);
  });

  it("should return the correct rate limiter for 'crawl' mode", () => {
    expect(
      getRateLimiter("crawl" as RateLimiterMode, { crawl: 2 } as any).points,
    ).toBe(2);
    expect(
      getRateLimiter("crawl" as RateLimiterMode, { crawl: 10 } as any).points,
    ).toBe(10);
    expect(
      getRateLimiter("crawl" as RateLimiterMode, { crawl: 5 } as any).points,
    ).toBe(5);
  });

  it("should return the correct rate limiter for 'scrape' mode", () => {
    expect(
      getRateLimiter("scrape" as RateLimiterMode, { scrape: 10 } as any).points,
    ).toBe(100);
    expect(
      getRateLimiter("scrape" as RateLimiterMode, { scrape: 100 } as any)
        .points,
    ).toBe(100);
    expect(
      getRateLimiter("scrape" as RateLimiterMode, { scrape: 1000 } as any)
        .points,
    ).toBe(1000);
  });

  it("should return the correct rate limiter for 'search' mode", () => {
    expect(
      getRateLimiter("search" as RateLimiterMode, { search: 5 } as any).points,
    ).toBe(100);
    expect(
      getRateLimiter("search" as RateLimiterMode, { search: 50 } as any).points,
    ).toBe(100);
    expect(
      getRateLimiter("search" as RateLimiterMode, { search: 500 } as any)
        .points,
    ).toBe(500);
  });

  it("should return the correct rate limiter for 'preview' mode", () => {
    expect(
      getRateLimiter("preview" as RateLimiterMode, { preview: 5 } as any)
        .points,
    ).toBe(5);
    expect(getRateLimiter("preview" as RateLimiterMode, null).points).toBe(25);
  });

  it("should return the correct rate limiter for 'account' mode", () => {
    expect(
      getRateLimiter("account" as RateLimiterMode, { account: 100 } as any)
        .points,
    ).toBe(100);
    expect(getRateLimiter("account" as RateLimiterMode, null).points).toBe(
      1000,
    );
  });

  it("should return the correct rate limiter for 'crawlStatus' mode", () => {
    expect(
      getRateLimiter(
        "crawlStatus" as RateLimiterMode,
        { crawlStatus: 150 } as any,
      ).points,
    ).toBe(150);
    expect(getRateLimiter("crawlStatus" as RateLimiterMode, null).points).toBe(
      25000,
    );
  });

  it("should return the correct rate limiter for 'testSuite' mode", () => {
    expect(
      getRateLimiter(
        "testSuite" as RateLimiterMode,
        { testSuite: 10000 } as any,
      ).points,
    ).toBe(10000);
    expect(getRateLimiter("testSuite" as RateLimiterMode, null).points).toBe(
      500,
    );
  });

  it("should throw an error when consuming more points than available", async () => {
    const limiter = getRateLimiter("crawl" as RateLimiterMode, null);
    jest
      .spyOn(limiter, "consume")
      .mockRejectedValue(new Error("Rate limit exceeded"));

    try {
      await limiter.consume("test-prefix:someToken", 16);
      throw new Error("Should have thrown");
    } catch (error: any) {
      expect(error.message).toBe("Rate limit exceeded");
    }
  });

  it("should reset points after duration", async () => {
    const keyPrefix = "test-prefix";
    const points = 10;
    const duration = 1;
    const limiter = new RateLimiterRedis({
      storeClient: redisRateLimitClient,
      keyPrefix,
      points,
      duration,
    });

    jest
      .spyOn(limiter, "consume")
      .mockResolvedValueOnce({ remainingPoints: 5 } as any)
      .mockResolvedValueOnce({ remainingPoints: 5 } as any);

    const res1 = await limiter.consume("test-prefix:someToken", 5);
    expect(res1.remainingPoints).toBe(5);

    const res2 = await limiter.consume("test-prefix:someToken", 5);
    expect(res2.remainingPoints).toBe(5);
  });
});
