/**
 * Unit tests for research rate-limit resolution.
 *
 * Research was historically absent from BASE_RATE_LIMITS, so the Autumn
 * multiplier was fetched per request and then discarded. These tests pin the
 * multiplier-scaling behaviour and the ceiling that bounds it.
 *
 * ioredis is mocked so importing the module under test never opens a socket;
 * `points` is a public field on RateLimiterRedis, so the resolved limit is
 * asserted directly off the returned limiter.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("ioredis", () => {
  class RedisStub {
    on() {
      return this;
    }
    defineCommand() {}
  }
  return { default: RedisStub, Redis: RedisStub };
});

import { getAutumnRateLimiter, getRateLimiter } from "../rate-limiter";
import { RateLimiterMode } from "../../types";

const pointsFor = (mode: RateLimiterMode, multiplier?: number) =>
  (getAutumnRateLimiter(mode, multiplier) as unknown as { points: number })
    .points;

describe("research rate limits", () => {
  it("leaves the free tier (x1) at its historical flat limit", () => {
    // Regression guard: adding research to BASE_RATE_LIMITS must not move the
    // limit for teams on the default multiplier.
    expect(pointsFor(RateLimiterMode.Research, 1)).toBe(100);
    expect(pointsFor(RateLimiterMode.Research)).toBe(100);
  });

  it("scales with the Autumn multiplier instead of discarding it", () => {
    expect(pointsFor(RateLimiterMode.Research, 10)).toBe(1_000);
    expect(pointsFor(RateLimiterMode.Research, 50)).toBe(5_000);
  });

  it("caps the multiplier-scaled limit at the research ceiling", () => {
    // Autumn fails open at x2500 (ERROR_FALLBACK_RATE_MULTIPLIER). Research is
    // a direct proxy with no concurrency queue, so the ceiling is the only
    // thing standing between an Autumn outage and an unbounded limit.
    expect(pointsFor(RateLimiterMode.Research, 2500)).toBe(10_000);
    expect(pointsFor(RateLimiterMode.Research, 1_000_000)).toBe(10_000);
  });

  it("treats a non-positive multiplier as x1 rather than zero", () => {
    expect(pointsFor(RateLimiterMode.Research, 0)).toBe(100);
    expect(pointsFor(RateLimiterMode.Research, -5)).toBe(100);
  });

  it("does not cap modes that have no ceiling configured", () => {
    // Scrape is queue-backstopped, so it keeps scaling past 10k.
    expect(pointsFor(RateLimiterMode.Scrape, 2500)).toBe(25_000);
  });

  it("keeps the preview-token path on the static fallback table", () => {
    expect(
      (
        getRateLimiter(RateLimiterMode.Research) as unknown as {
          points: number;
        }
      ).points,
    ).toBe(100);
  });
});
