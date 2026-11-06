import { beforeEach, describe, expect, it, vi } from "vitest";

const OVERRIDDEN_TEAM = "00000000-0000-4000-8000-000000000001";
const OTHER_TEAM = "00000000-0000-4000-8000-000000000002";

// config parses the overrides at import, so set them first.
const { redis } = vi.hoisted(() => {
  process.env.GOV_INDEX_CALLS_PER_DAY_OVERRIDES =
    " 00000000-0000-4000-8000-000000000001:20000 ,";
  return { redis: { eval: vi.fn() } };
});

vi.mock("../../services/rate-limiter", () => ({ redisRateLimitClient: redis }));
vi.mock("../../db/connection", () => ({ db: {}, dbRr: {}, dbIndex: {} }));

import { config } from "../../config";
import {
  indexDailyLimitRefusal,
  reserveIndexCalls,
} from "../index-daily-limit";
import { teamBillingUrl } from "../team-billing-url";

const NOW = new Date("2026-10-27T12:00:00Z");

function limitPassedToRedis() {
  return redis.eval.mock.calls[0][4];
}

beforeEach(() => {
  redis.eval.mockReset();
  redis.eval.mockResolvedValue([1, 0]);
});

describe("Government Index per-team overrides", () => {
  it("parses the configured list", () => {
    expect(config.GOV_INDEX_CALLS_PER_DAY_OVERRIDES).toEqual({
      [OVERRIDDEN_TEAM]: 20000,
    });
  });

  it("uses the override for a listed team", async () => {
    await reserveIndexCalls("gov", OVERRIDDEN_TEAM, 1, 51, NOW);
    expect(limitPassedToRedis()).toBe(20000);
  });

  it("keeps the plan limit for other teams", async () => {
    await reserveIndexCalls("gov", OTHER_TEAM, 1, 51, NOW);
    expect(limitPassedToRedis()).toBe(1000);
  });

  it("does not apply to the Research Index", async () => {
    await reserveIndexCalls("research", OVERRIDDEN_TEAM, 1, 1, NOW);
    expect(limitPassedToRedis()).toBe(1000);
  });

  it("reports the override in the refusal", async () => {
    redis.eval.mockResolvedValue([0, 19990]);
    const reservation = await reserveIndexCalls(
      "gov",
      OVERRIDDEN_TEAM,
      1,
      51,
      NOW,
    );
    expect(reservation.ok).toBe(false);
    if (reservation.ok) return;
    const refusal = indexDailyLimitRefusal("gov", OVERRIDDEN_TEAM, reservation);
    expect(refusal.limit).toBe(20000);
    expect(refusal.error).toContain("19,990 of its 20,000 calls today");
    expect(refusal.upgradeUrl).toBe(teamBillingUrl(OVERRIDDEN_TEAM));
    expect(refusal.error).toContain(teamBillingUrl(OVERRIDDEN_TEAM));
  });

  it("keeps the public pricing page for a keyless caller", () => {
    const reservation = {
      ok: false as const,
      used: 1000,
      limit: 1000,
      requested: 1,
      retryAfterSeconds: 3600,
      resetsAt: new Date("2026-10-28T00:00:00.000Z"),
    };
    const refusal = indexDailyLimitRefusal(
      "gov",
      "preview_keyless_203.0.113.8",
      reservation,
    );
    expect(refusal.upgradeUrl).toBe("https://firecrawl.dev/pricing");
    expect(refusal.error).toContain("https://firecrawl.dev/pricing");
    expect(refusal.error).toContain("without an API key");
  });
});
