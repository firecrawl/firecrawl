import { randomUUID } from "crypto";
vi.mock("../../services/rate-limiter", async () => {
  const { Redis } = await import("ioredis");
  return {
    redisRateLimitClient: new Redis(
      process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      { maxRetriesPerRequest: 1 },
    ),
  };
});
vi.mock("../../db/connection", () => ({ db: {} }));
vi.mock("../../lib/spur", () => ({ isKeylessIpSuspicious: vi.fn() }));
import { redisRateLimitClient as redis } from "../../services/rate-limiter";
import { adjustKeylessCredits, keylessTeamId } from "../../lib/keyless";

describe("retryable Redis credit reconciliation", () => {
  const ip = "192.0.2.198";
  const team = keylessTeamId(ip);
  const id = randomUUID();
  const key = `keyless_credits:${ip}`;
  const marker = `keyless_adjustment:${ip}:${id}`;
  const persistentReceipt = `test:browser_session:keyless_billing:${id}`;
  beforeEach(async () => {
    await redis.del(key, marker, persistentReceipt);
  });
  afterAll(async () => {
    await redis.del(key, marker, persistentReceipt);
    await redis.quit();
  });
  it("applies the same session adjustment once before billing is claimed", async () => {
    await redis.set(key, 20);
    expect(await adjustKeylessCredits(team, -7, id)).toBe(13);
    expect(await adjustKeylessCredits(team, -7, id)).toBe(13);
    expect(await redis.ttl(marker)).toBeGreaterThan(0);
  });
  it("keeps a persistent receipt after the daily counter is replaced", async () => {
    await redis.set(key, 20);
    expect(
      await adjustKeylessCredits(team, -7, id, { persistentReceipt }),
    ).toBe(13);
    expect(await redis.ttl(persistentReceipt)).toBe(-1);
    await redis.del(key);
    await redis.set(key, 50);
    expect(
      await adjustKeylessCredits(team, -7, id, { persistentReceipt }),
    ).toBe(50);
    expect(await redis.get(key)).toBe("50");
  });
  it("rejects an invalid counter without claiming the adjustment", async () => {
    await redis.hset(key, "invalid", "counter");
    await expect(adjustKeylessCredits(team, -7, id)).rejects.toThrow(
      "WRONGTYPE",
    );
    expect(await redis.exists(marker)).toBe(0);
    await redis.del(key);
    await redis.set(key, 20);
    expect(await adjustKeylessCredits(team, -7, id)).toBe(13);
  });
});
