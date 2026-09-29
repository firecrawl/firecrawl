import { beforeEach, describe, expect, it, vi } from "vitest";

/** The handful of Redis commands the retrier uses, in memory. */
class FakeRedis {
  zset = new Map<string, number>();
  hash = new Map<string, string>();
  lock: string | null = null;
  hang = false;

  async set(_k: string, v: string, _px: string, _ms: number, _nx: string) {
    if (this.lock !== null) return null;
    this.lock = v;
    return "OK";
  }
  async del() {
    this.lock = null;
  }
  async zrangebyscore(_k: string, _min: string, max: number) {
    return [...this.zset.entries()]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async hget(_k: string, field: string) {
    return this.hash.get(field) ?? null;
  }
  async zrem(_k: string, member: string) {
    this.zset.delete(member);
  }
  multi() {
    const ops: Array<() => void> = [];
    const chain = {
      hsetnx: (_k: string, f: string, v: string) => {
        ops.push(() => void (this.hash.has(f) || this.hash.set(f, v)));
        return chain;
      },
      hset: (_k: string, f: string, v: string) => {
        ops.push(() => void this.hash.set(f, v));
        return chain;
      },
      hdel: (_k: string, f: string) => {
        ops.push(() => void this.hash.delete(f));
        return chain;
      },
      zadd: (_k: string, mode: "NX" | "XX", score: number, m: string) => {
        ops.push(() => {
          const has = this.zset.has(m);
          if ((mode === "NX" && !has) || (mode === "XX" && has))
            this.zset.set(m, score);
        });
        return chain;
      },
      zrem: (_k: string, m: string) => {
        ops.push(() => void this.zset.delete(m));
        return chain;
      },
      exec: () =>
        this.hang
          ? new Promise(() => {})
          : Promise.resolve(ops.forEach(op => op())),
    };
    return chain;
  }
}

const { redis } = vi.hoisted(() => ({ redis: { current: null as any } }));
vi.mock("../../queue-service", () => ({
  getRedisConnection: () => redis.current,
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  MAX_AGE_MS,
  backoffMs,
  handOffTrack,
  retryDueTracks,
} from "../firebill-retry";
import { firebillTrackRetryTotal } from "../metrics";
import { logger } from "../../../lib/logger";

const params = {
  customerId: "org-1",
  entityId: "team-1",
  featureId: "CREDITS",
  value: 3,
  properties: {},
  idempotencyKey: "fc:track:scrape:job-1",
};

const outcomes = async () =>
  Object.fromEntries(
    (await firebillTrackRetryTotal.get()).values.map(v => [
      v.labels.outcome,
      v.value,
    ]),
  );

let fake: FakeRedis;
beforeEach(() => {
  fake = new FakeRedis();
  redis.current = fake;
  firebillTrackRetryTotal.reset();
  vi.mocked(logger.error).mockClear();
});

describe("handOffTrack", () => {
  it("stores the event due after the first delay", async () => {
    await expect(handOffTrack("/v1/track", params, 1000)).resolves.toBe(true);
    expect(fake.zset.get(params.idempotencyKey)).toBe(1000 + backoffMs(1));
    expect(JSON.parse(fake.hash.get(params.idempotencyKey)!)).toMatchObject({
      path: "/v1/track",
      firstFailedAt: 1000,
      attempts: 0,
    });
    expect(await outcomes()).toEqual({ queued: 1 });
  });

  it("keeps the original age when the same event is handed off twice", async () => {
    await handOffTrack("/v1/track", params, 1000);
    await handOffTrack("/v1/track", params, 50000);
    expect(
      JSON.parse(fake.hash.get(params.idempotencyKey)!).firstFailedAt,
    ).toBe(1000);
    expect(fake.zset.get(params.idempotencyKey)).toBe(1000 + backoffMs(1));
  });

  it("bounds the caller's wait when Redis does not answer", async () => {
    fake.hang = true;
    const started = Date.now();
    await expect(handOffTrack("/v1/track", params)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await outcomes()).toEqual({ queue_failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("retryDueTracks", () => {
  it("leaves an event alone until it is due", async () => {
    await handOffTrack("/v1/track", params, 0);
    const attempt = vi.fn(async () => ({ ok: true }));
    await retryDueTracks(attempt, backoffMs(1) - 1);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("removes an event once firebill accepts it", async () => {
    await handOffTrack("/v1/track", params, 0);
    const attempt = vi.fn(async () => ({ ok: true }));
    await retryDueTracks(attempt, backoffMs(1));
    expect(attempt).toHaveBeenCalledWith(
      "/v1/track",
      expect.objectContaining({ idempotencyKey: params.idempotencyKey }),
    );
    expect(fake.zset.size).toBe(0);
    expect(fake.hash.size).toBe(0);
    expect(await outcomes()).toMatchObject({ recovered: 1 });
  });

  it("backs off and keeps an event firebill still does not confirm", async () => {
    await handOffTrack("/v1/track", params, 0);
    const now = backoffMs(1);
    await retryDueTracks(async () => ({ ok: false }), now);
    expect(fake.zset.get(params.idempotencyKey)).toBe(now + backoffMs(1));
    await retryDueTracks(async () => ({ ok: false }), now + backoffMs(1));
    expect(fake.zset.get(params.idempotencyKey)).toBe(
      now + backoffMs(1) + backoffMs(2),
    );
    expect(JSON.parse(fake.hash.get(params.idempotencyKey)!).attempts).toBe(2);
  });

  it("gives up loudly past the age limit instead of risking a double charge", async () => {
    await handOffTrack("/v1/track", params, 0);
    const attempt = vi.fn(async () => ({ ok: true }));
    await retryDueTracks(attempt, MAX_AGE_MS + 1);
    expect(attempt).not.toHaveBeenCalled();
    expect(fake.zset.size).toBe(0);
    expect(await outcomes()).toMatchObject({ expired: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("skips the pass while another process holds the lease", async () => {
    await handOffTrack("/v1/track", params, 0);
    fake.lock = "other";
    const attempt = vi.fn(async () => ({ ok: true }));
    await retryDueTracks(attempt, backoffMs(1));
    expect(attempt).not.toHaveBeenCalled();
  });

  it("caps the delay between attempts", () => {
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(2)).toBe(10000);
    expect(backoffMs(20)).toBe(120000);
  });
});
