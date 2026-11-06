import { vi } from "vitest";
import { config } from "../config";
import { RateLimiterMode } from "../types";
import type { TeamFlags } from "../controllers/v1/types";

// The module builds a Redis client at import time. Stub ioredis so the limiter
// can be constructed without a live server.
vi.mock("ioredis", () => ({
  default: class {
    defineCommand() {}
  },
}));

import {
  getAutumnRateLimiter,
  getHostedMcpConcurrencyLimit,
  getHostedMcpRateLimiter,
} from "./rate-limiter";

// import {
//   getRateLimiter,
//   serverRateLimiter,
//   redisRateLimitClient,
// } from "./rate-limiter";
// import { RateLimiterMode } from "../../src/types";
// import { RateLimiterRedis } from "rate-limiter-flexible";

// describe("Rate Limiter Service", () => {
//   beforeAll(async () => {
//     try {
//       await redisRateLimitClient.connect();
//       // if (config.REDIS_RATE_LIMIT_URL === "redis://localhost:6379") {
//       //   console.log("Erasing all keys");
//       //   // erase all the keys that start with "test-prefix"
//       //   const keys = await redisRateLimitClient.keys("test-prefix:*");
//       //   if (keys.length > 0) {
//       //     await redisRateLimitClient.del(...keys);
//       //   }
//       // }
//     } catch (error) {}
//   });

//   afterAll(async () => {
//     try {
//       // if (config.REDIS_RATE_LIMIT_URL === "redis://localhost:6379") {
//       await redisRateLimitClient.disconnect();
//       // }
//     } catch (error) {}
//   });

//   it("should return the testSuiteRateLimiter for specific tokens", () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:a01ccae",
//     );
//     expect(limiter).toBe(testSuiteRateLimiter);

//     const limiter2 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:6254cf9",
//     );
//     expect(limiter2).toBe(testSuiteRateLimiter);
//   });

//   it("should return the serverRateLimiter if mode is not found", () => {
//     const limiter = getRateLimiter(
//       "nonexistent" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter.points).toBe(serverRateLimiter.points);
//   });

//   it("should return the correct rate limiter based on mode and plan", () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(2);

//     const limiter2 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//       "standard",
//     );
//     expect(limiter2.points).toBe(100);

//     const limiter3 = getRateLimiter(
//       "search" as RateLimiterMode,
//       "test-prefix:someToken",
//       "growth",
//     );
//     expect(limiter3.points).toBe(500);

//     const limiter4 = getRateLimiter(
//       "crawlStatus" as RateLimiterMode,
//       "test-prefix:someToken",
//       "growth",
//     );
//     expect(limiter4.points).toBe(250);
//   });

//   it("should return the default rate limiter if plan is not provided", () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter.points).toBe(3);

//     const limiter2 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(20);
//   });

//   it("should create a new RateLimiterRedis instance with correct parameters", () => {
//     const keyPrefix = "test-prefix";
//     const points = 10;
//     const limiter = new RateLimiterRedis({
//       storeClient: redisRateLimitClient,
//       keyPrefix,
//       points,
//       duration: 60,
//     });

//     expect(limiter.keyPrefix).toBe(keyPrefix);
//     expect(limiter.points).toBe(points);
//     expect(limiter.duration).toBe(60);
//   });

//   it("should return the correct rate limiter for 'preview' mode", () => {
//     const limiter = getRateLimiter(
//       "preview" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(5);

//     const limiter2 = getRateLimiter(
//       "preview" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(5);
//   });

//   it("should return the correct rate limiter for 'account' mode", () => {
//     const limiter = getRateLimiter(
//       "account" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(100);

//     const limiter2 = getRateLimiter(
//       "account" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(100);
//   });

//   it("should return the correct rate limiter for 'crawlStatus' mode", () => {
//     const limiter = getRateLimiter(
//       "crawlStatus" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(150);

//     const limiter2 = getRateLimiter(
//       "crawlStatus" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(250);
//   });

//   it("should consume points correctly for 'crawl' mode", async () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someTokenCRAWL",
//       "free",
//     );
//     const consumePoints = 1;

//     const res = await limiter.consume(
//       "test-prefix:someTokenCRAWL",
//       consumePoints,
//     );
//     expect(res.remainingPoints).toBe(1);
//   });

//   it("should consume points correctly for 'scrape' mode (DEFAULT)", async () => {
//     const limiter = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someTokenX",
//     );
//     const consumePoints = 4;

//     const res = await limiter.consume("test-prefix:someTokenX", consumePoints);
//     expect(res.remainingPoints).toBe(16);
//   });

//   it("should consume points correctly for 'scrape' mode (HOBBY)", async () => {
//     const limiter = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someTokenXY",
//       "hobby",
//     );
//     expect(limiter.points).toBe(20);

//     const consumePoints = 5;

//     const res = await limiter.consume("test-prefix:someTokenXY", consumePoints);
//     expect(res.consumedPoints).toBe(5);
//     expect(res.remainingPoints).toBe(15);
//   });

//   it("should return the correct rate limiter for 'crawl' mode", () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(2);

//     const limiter2 = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//       "starter",
//     );
//     expect(limiter2.points).toBe(10);

//     const limiter3 = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//       "standard",
//     );
//     expect(limiter3.points).toBe(5);
//   });

//   it("should return the correct rate limiter for 'scrape' mode", () => {
//     const limiter = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(10);

//     const limiter2 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//       "starter",
//     );
//     expect(limiter2.points).toBe(100);

//     const limiter3 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//       "standard",
//     );
//     expect(limiter3.points).toBe(100);

//     const limiter4 = getRateLimiter(
//       "scrape" as RateLimiterMode,
//       "test-prefix:someToken",
//       "growth",
//     );
//     expect(limiter4.points).toBe(1000);
//   });

//   it("should return the correct rate limiter for 'search' mode", () => {
//     const limiter = getRateLimiter(
//       "search" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(5);

//     const limiter2 = getRateLimiter(
//       "search" as RateLimiterMode,
//       "test-prefix:someToken",
//       "starter",
//     );
//     expect(limiter2.points).toBe(50);

//     const limiter3 = getRateLimiter(
//       "search" as RateLimiterMode,
//       "test-prefix:someToken",
//       "standard",
//     );
//     expect(limiter3.points).toBe(50);
//   });

//   it("should return the correct rate limiter for 'preview' mode", () => {
//     const limiter = getRateLimiter(
//       "preview" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(5);

//     const limiter2 = getRateLimiter(
//       "preview" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(5);
//   });

//   it("should return the correct rate limiter for 'account' mode", () => {
//     const limiter = getRateLimiter(
//       "account" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(100);

//     const limiter2 = getRateLimiter(
//       "account" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(100);
//   });

//   it("should return the correct rate limiter for 'crawlStatus' mode", () => {
//     const limiter = getRateLimiter(
//       "crawlStatus" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(150);

//     const limiter2 = getRateLimiter(
//       "crawlStatus" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(250);
//   });

//   it("should return the correct rate limiter for 'testSuite' mode", () => {
//     const limiter = getRateLimiter(
//       "testSuite" as RateLimiterMode,
//       "test-prefix:someToken",
//       "free",
//     );
//     expect(limiter.points).toBe(10000);

//     const limiter2 = getRateLimiter(
//       "testSuite" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     expect(limiter2.points).toBe(10000);
//   });

//   it("should throw an error when consuming more points than available", async () => {
//     const limiter = getRateLimiter(
//       "crawl" as RateLimiterMode,
//       "test-prefix:someToken",
//     );
//     const consumePoints = limiter.points + 1;

//     try {
//       await limiter.consume("test-prefix:someToken", consumePoints);
//     } catch (error) {
//       // expect remaining points to be 0
//       const res = await limiter.get("test-prefix:someToken");
//       expect(res?.remainingPoints).toBe(0);
//     }
//   });

//   it("should reset points after duration", async () => {
//     const keyPrefix = "test-prefix";
//     const points = 10;
//     const duration = 1; // 1 second
//     const limiter = new RateLimiterRedis({
//       storeClient: redisRateLimitClient,
//       keyPrefix,
//       points,
//       duration,
//     });

//     const consumePoints = 5;
//     await limiter.consume("test-prefix:someToken", consumePoints);
//     await new Promise((resolve) => setTimeout(resolve, duration * 1000 + 100)); // Wait for duration + 100ms

//     const res = await limiter.consume("test-prefix:someToken", consumePoints);
//     expect(res.remainingPoints).toBe(points - consumePoints);
//   });
// });
// TODO: FIX

describe("getAutumnRateLimiter", () => {
  const flagsWith = (overrides: unknown): TeamFlags =>
    ({ rateLimitOverrides: overrides }) as TeamFlags;

  it("multiplies the base limit when there is no override", () => {
    expect(getAutumnRateLimiter(RateLimiterMode.Scrape, 5).points).toBe(50);
    expect(getAutumnRateLimiter(RateLimiterMode.Scrape, 5, null).points).toBe(
      50,
    );
    expect(
      getAutumnRateLimiter(RateLimiterMode.Scrape, 5, {} as TeamFlags).points,
    ).toBe(50);
  });

  it("scales the exchange mode like scrape", () => {
    expect(getAutumnRateLimiter(RateLimiterMode.Exchange, 1).points).toBe(10);
    expect(getAutumnRateLimiter(RateLimiterMode.Exchange, 50).points).toBe(
      getAutumnRateLimiter(RateLimiterMode.Scrape, 50).points,
    );
    expect(getAutumnRateLimiter(RateLimiterMode.Exchange).keyPrefix).toBe(
      "exchange",
    );
  });

  it("gives exchange discover a flat 10000 regardless of multiplier", () => {
    expect(
      getAutumnRateLimiter(RateLimiterMode.ExchangeDiscover, 1).points,
    ).toBe(10000);
    expect(
      getAutumnRateLimiter(RateLimiterMode.ExchangeDiscover, 1000).points,
    ).toBe(10000);
  });

  describe("hosted MCP minimum", () => {
    it("raises free and hobby to 600 and standard to 2,000 in a bucket of its own", () => {
      for (const mode of [RateLimiterMode.Scrape, RateLimiterMode.Search]) {
        // Free, hobby and the ×11 and ×25 variants round down to hobby;
        // standard and the ×60 to ×199 variants round down to standard.
        for (const [multiplier, limit] of [
          [1, 600],
          [5, 600],
          [10, 600],
          [11, 600],
          [25, 600],
          [50, 2000],
          [60, 2000],
          [199, 2000],
        ]) {
          const limiter = getHostedMcpRateLimiter(mode, multiplier);
          expect(limiter?.points).toBe(limit);
          expect(limiter?.keyPrefix).toBe(`hostedMcp:${mode}`);
        }
      }
    });

    it("leaves plans already at or above their minimum on their normal limiter", () => {
      // A ×200 variant (exactly 2,000), growth and scale.
      for (const multiplier of [200, 500, 1000]) {
        expect(
          getHostedMcpRateLimiter(RateLimiterMode.Scrape, multiplier),
        ).toBe(undefined);
      }
    });

    it("scales every multiplier-scaled mode by the same tier multiplier", () => {
      // ×60 on free and hobby, ×200 on standard, applied to each mode's base.
      for (const [mode, free, standard] of [
        [RateLimiterMode.Map, 600, 2000],
        [RateLimiterMode.Exchange, 600, 2000],
        [RateLimiterMode.BrowserExecute, 600, 2000],
        [RateLimiterMode.Crawl, 120, 400],
        [RateLimiterMode.Extract, 120, 400],
        [RateLimiterMode.Browser, 120, 400],
        [RateLimiterMode.CrawlStatus, 30000, 100000],
        [RateLimiterMode.ExtractStatus, 30000, 100000],
      ] as const) {
        const freeLimiter = getHostedMcpRateLimiter(mode, 1);
        expect(freeLimiter?.points).toBe(free);
        expect(freeLimiter?.keyPrefix).toBe(`hostedMcp:${mode}`);
        expect(getHostedMcpRateLimiter(mode, 10)?.points).toBe(free);
        expect(getHostedMcpRateLimiter(mode, 50)?.points).toBe(standard);
        expect(getHostedMcpRateLimiter(mode, 500)).toBe(undefined);
      }
    });

    it("leaves flat modes and overridden modes alone", () => {
      for (const mode of [
        RateLimiterMode.ExchangeDiscover,
        RateLimiterMode.Account,
        RateLimiterMode.Research,
      ]) {
        expect(getHostedMcpRateLimiter(mode, 1)).toBe(undefined);
      }
      expect(
        getHostedMcpRateLimiter(
          RateLimiterMode.Scrape,
          1,
          flagsWith({ [RateLimiterMode.Scrape]: 5 }),
        ),
      ).toBe(undefined);
    });

    it("treats a multiplier of zero or below as ×1", () => {
      expect(getHostedMcpRateLimiter(RateLimiterMode.Scrape, 0)?.points).toBe(
        600,
      );
    });
  });

  describe("hosted MCP concurrency minimum", () => {
    it("raises free to 25, hobby to 50 and standard to 75", () => {
      for (const [multiplier, limit, concurrency] of [
        [1, 2, 25],
        [10, 5, 50],
        [25, 5, 50],
        [50, 50, 75],
        [100, 50, 75],
      ]) {
        expect(
          getHostedMcpConcurrencyLimit(
            RateLimiterMode.Scrape,
            limit,
            multiplier,
          ),
        ).toBe(concurrency);
      }
    });

    it("keeps a team limit already at or above its tier", () => {
      expect(getHostedMcpConcurrencyLimit(RateLimiterMode.Scrape, 25, 1)).toBe(
        undefined,
      );
      expect(getHostedMcpConcurrencyLimit(RateLimiterMode.Scrape, 60, 10)).toBe(
        undefined,
      );
      expect(getHostedMcpConcurrencyLimit(RateLimiterMode.Scrape, 75, 50)).toBe(
        undefined,
      );
    });

    it("leaves growth and up, other modes and overridden modes alone", () => {
      expect(
        getHostedMcpConcurrencyLimit(RateLimiterMode.Scrape, 50, 500),
      ).toBe(undefined);
      for (const mode of [RateLimiterMode.Search, RateLimiterMode.Crawl]) {
        expect(getHostedMcpConcurrencyLimit(mode, 2, 1)).toBe(undefined);
      }
      expect(
        getHostedMcpConcurrencyLimit(
          RateLimiterMode.Scrape,
          2,
          1,
          flagsWith({ [RateLimiterMode.Scrape]: 5 }),
        ),
      ).toBe(undefined);
    });
  });

  it("replaces the computed limit with the override for that mode", () => {
    const limiter = getAutumnRateLimiter(
      RateLimiterMode.Scrape,
      5,
      flagsWith({ [RateLimiterMode.Scrape]: 42 }),
    );

    expect(limiter.points).toBe(42);
  });

  it("keeps the normal limit when only another mode is overridden", () => {
    const limiter = getAutumnRateLimiter(
      RateLimiterMode.Scrape,
      5,
      flagsWith({ [RateLimiterMode.Map]: 42 }),
    );

    expect(limiter.points).toBe(50);
  });

  it("applies the override to a mode that has no base limit", () => {
    // Research is not multiplier-scaled, so it normally uses the fallback 100.
    expect(getAutumnRateLimiter(RateLimiterMode.Research, 5).points).toBe(100);
    expect(
      getAutumnRateLimiter(
        RateLimiterMode.Research,
        5,
        flagsWith({ [RateLimiterMode.Research]: 7 }),
      ).points,
    ).toBe(7);
  });

  it.each([
    ["zero", 0],
    ["a negative number", -10],
    ["a non-integer", 12.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "42"],
    ["null", null],
    ["an object", { rpm: 42 }],
  ])("ignores an override of %s", (_label, value) => {
    const limiter = getAutumnRateLimiter(
      RateLimiterMode.Scrape,
      5,
      flagsWith({ [RateLimiterMode.Scrape]: value }),
    );

    expect(limiter.points).toBe(50);
  });

  it("ignores an override map that is not an object", () => {
    expect(
      getAutumnRateLimiter(RateLimiterMode.Scrape, 5, flagsWith(null)).points,
    ).toBe(50);
    expect(
      getAutumnRateLimiter(RateLimiterMode.Scrape, 5, flagsWith("scrape=42"))
        .points,
    ).toBe(50);
  });
});
