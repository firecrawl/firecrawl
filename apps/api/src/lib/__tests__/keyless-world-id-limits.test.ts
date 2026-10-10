import { describe, expect, it, vi } from "vitest";

// keyless.ts reads its daily limits at import, so set them first.
const { redis } = vi.hoisted(() => {
  process.env.KEYLESS_REQUESTS_PER_DAY = "10";
  process.env.KEYLESS_CREDITS_PER_DAY = "100";
  return {
    redis: {
      incr: vi.fn(),
      expire: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue("0"),
      ttl: vi.fn().mockResolvedValue(-1),
      eval: vi.fn().mockResolvedValue([1, 1]),
    },
  };
});

vi.mock("../../services/rate-limiter", () => ({ redisRateLimitClient: redis }));
vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));

import {
  consumeKeylessRequest,
  keylessTeamId,
  keylessWorldIdIdentity,
  reserveKeylessCredits,
} from "../keyless";

const WORLD_ID = keylessWorldIdIdentity("h".repeat(43));

describe("keyless limits for a World ID identity", () => {
  it("allows 20% more requests than the per-IP tier", async () => {
    redis.incr.mockResolvedValue(12);
    expect((await consumeKeylessRequest(WORLD_ID)).ok).toBe(true);
    expect((await consumeKeylessRequest("203.0.113.8")).ok).toBe(false);

    redis.incr.mockResolvedValue(13);
    expect(await consumeKeylessRequest(WORLD_ID)).toMatchObject({
      ok: false,
      reason: "requests",
    });
  });

  it("keeps its own request bucket, apart from any IP", async () => {
    redis.incr.mockResolvedValue(1);
    await consumeKeylessRequest(WORLD_ID);
    expect(redis.incr).toHaveBeenLastCalledWith(`keyless_requests:${WORLD_ID}`);
  });

  it("reserves credits against 20% more than the per-IP tier", async () => {
    const result = await reserveKeylessCredits(keylessTeamId(WORLD_ID), 5);
    expect(result.limit).toBe(120);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      `keyless_credits:${WORLD_ID}`,
      5,
      120,
      86400,
    );

    expect(
      (await reserveKeylessCredits(keylessTeamId("203.0.113.8"), 5)).limit,
    ).toBe(100);
  });
});
