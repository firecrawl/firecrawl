import { vi } from "vitest";

const redisMocks = vi.hoisted(() => ({
  eval: vi.fn(),
  zrangebyscore: vi.fn(),
  zrem: vi.fn(),
  zcard: vi.fn(),
  zcount: vi.fn(),
}));
const evalMock = redisMocks.eval;

vi.mock("../services/queue-service", () => ({
  getRedisConnection: () => redisMocks,
}));

import {
  CONCURRENCY_ROLLBACK_MARKER_TTL_MS,
  finalizeConcurrencyLimitActiveJobRollback,
  getConcurrencyLimitActiveJobsCount,
  getConcurrencyRollbackCleanupBacklog,
  pushConcurrencyLimitActiveJob,
  recoverConcurrencyLimitRollbacks,
  renewConcurrencyLimitActiveJob,
  reserveConcurrencyLimitActiveJob,
  rollbackConcurrencyLimitActiveJob,
} from "./concurrency-redis";

describe("PG concurrency slot reservation", () => {
  beforeEach(() => vi.clearAllMocks());

  test("uses one Redis script for capacity check and insertion", async () => {
    evalMock.mockResolvedValue([1, 1]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 3, 30_000),
    ).resolves.toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
      cleanupToken: null,
    });

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [
      script,
      keyCount,
      key,
      reservationKey,
      holder,
      limit,
      ttl,
      operationToken,
    ] = evalMock.mock.calls[0];
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZCARD");
    expect(script).toContain("ZADD");
    expect(script).toContain("cleanup:");
    expect(keyCount).toBe(2);
    expect(key).toBe("concurrency-limiter:team");
    expect(reservationKey).toBe("concurrency-limiter:team:reservation:holder");
    expect([holder, limit, ttl]).toEqual(["holder", 3, 30_000]);
    expect(operationToken).toEqual(expect.any(String));
  });

  test("preserves denied and idempotent-renewal outcomes", async () => {
    evalMock.mockResolvedValueOnce([0, 0]).mockResolvedValueOnce([1, 0]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "new", 1, 30_000),
    ).resolves.toEqual({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
    await expect(
      reserveConcurrencyLimitActiveJob("team", "existing", 1, 30_000),
    ).resolves.toEqual({
      reserved: true,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: null,
    });
  });

  test("retries an ambiguous reservation reply without losing ownership", async () => {
    evalMock
      .mockRejectedValueOnce(new Error("connection lost after write"))
      .mockResolvedValueOnce([1, 1]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 1, 30_000),
    ).resolves.toMatchObject({
      reserved: true,
      newlyAcquired: true,
      rollbackToken: expect.any(String),
      cleanupToken: null,
    });
    expect(evalMock).toHaveBeenCalledTimes(2);
    expect(evalMock.mock.calls[1].slice(1)).toEqual(
      evalMock.mock.calls[0].slice(1),
    );
  });

  test("surfaces an abandoned cleanup tombstone for recovery", async () => {
    evalMock.mockResolvedValueOnce([2, "abandoned-token"]);

    await expect(
      reserveConcurrencyLimitActiveJob("team", "holder", 1, 30_000),
    ).resolves.toEqual({
      reserved: false,
      newlyAcquired: false,
      rollbackToken: null,
      cleanupToken: "abandoned-token",
    });
  });

  test("guarded rollback refuses to delete a replacement owner", async () => {
    evalMock.mockResolvedValueOnce(0);

    await expect(
      rollbackConcurrencyLimitActiveJob("team", "holder", "stale-token"),
    ).resolves.toBe(false);
    expect(evalMock.mock.calls[0]).toEqual([
      expect.stringContaining("GET"),
      3,
      "concurrency-limiter:team",
      "concurrency-limiter:team:reservation:holder",
      "concurrency-rollback-cleanup:v1",
      "holder",
      "stale-token",
      JSON.stringify({
        v: 1,
        teamId: "team",
        id: "holder",
        token: "stale-token",
      }),
      CONCURRENCY_ROLLBACK_MARKER_TTL_MS,
    ]);
    expect(evalMock.mock.calls[0][0]).not.toContain("PERSIST");
  });

  test("finalizes the cleanup tombstone by ownership token", async () => {
    evalMock.mockResolvedValueOnce(1);

    await expect(
      finalizeConcurrencyLimitActiveJobRollback(
        "team",
        "holder",
        "owned-token",
      ),
    ).resolves.toBe(true);
    expect(evalMock.mock.calls[0]).toEqual([
      expect.stringContaining("cleanup:"),
      2,
      "concurrency-limiter:team:reservation:holder",
      "concurrency-rollback-cleanup:v1",
      "owned-token",
      JSON.stringify({
        v: 1,
        teamId: "team",
        id: "holder",
        token: "owned-token",
      }),
    ]);
  });

  test("recovers abandoned rollback without a same-holder retry", async () => {
    const member = JSON.stringify({
      v: 1,
      teamId: "team",
      id: "holder",
      token: "abandoned",
    });
    redisMocks.zrangebyscore.mockResolvedValue([member]);
    evalMock.mockResolvedValue(1);

    await expect(recoverConcurrencyLimitRollbacks(10)).resolves.toEqual({
      read: 1,
      finalized: 1,
      fenced: 0,
      hasMore: false,
    });
    expect(redisMocks.zrangebyscore).toHaveBeenCalledWith(
      "concurrency-rollback-cleanup:v1",
      "-inf",
      expect.any(Number),
      "LIMIT",
      0,
      10,
    );
    expect(evalMock.mock.calls[0]).toEqual([
      expect.stringContaining("Never delete it"),
      2,
      "concurrency-limiter:team:reservation:holder",
      "concurrency-rollback-cleanup:v1",
      "abandoned",
      member,
    ]);
  });

  test("renewal/reacquire fencing and marker loss only retire the old index", async () => {
    const replacement = JSON.stringify({
      v: 1,
      teamId: "team",
      id: "replacement",
      token: "old",
    });
    const lost = JSON.stringify({
      v: 1,
      teamId: "team",
      id: "lost",
      token: "lost",
    });
    redisMocks.zrangebyscore.mockResolvedValue([replacement, lost]);
    evalMock.mockResolvedValue(0);

    await expect(recoverConcurrencyLimitRollbacks(2)).resolves.toEqual({
      read: 2,
      finalized: 0,
      fenced: 2,
      hasMore: true,
    });
    const script = evalMock.mock.calls[0][0] as string;
    expect(script).toContain("marker == 'cleanup:'");
    expect(script).not.toContain("ZREM', KEYS[1]");
  });

  test("reports exact bounded cleanup backlog and oldest overdue age", async () => {
    evalMock.mockResolvedValue([7, 3, "900"]);

    await expect(getConcurrencyRollbackCleanupBacklog(1_000)).resolves.toEqual({
      total: 7,
      due: 3,
      oldestDueAt: 900,
      oldestOverdueMs: 100,
    });
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringMatching(/ZCARD[\s\S]*ZCOUNT[\s\S]*ZRANGEBYSCORE/),
      1,
      "concurrency-rollback-cleanup:v1",
      1_000,
    );
    expect(evalMock.mock.calls[0][0]).toContain("'LIMIT', 0, 1");
  });

  test("fails closed on corrupt cleanup accounting", async () => {
    evalMock.mockResolvedValue([1, 2, ""]);
    await expect(getConcurrencyRollbackCleanupBacklog(1_000)).rejects.toThrow(
      "Corrupt Redis rollback cleanup accounting",
    );
  });

  test("uses Redis time for legacy reads, writes, and renewals", async () => {
    evalMock
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    await expect(getConcurrencyLimitActiveJobsCount("team")).resolves.toBe(2);
    await pushConcurrencyLimitActiveJob("team", "holder", 30_000);
    await expect(
      renewConcurrencyLimitActiveJob("team", "holder", 30_000),
    ).resolves.toBe(true);

    expect(evalMock.mock.calls[0][0]).toContain("redis.call('TIME')");
    expect(evalMock.mock.calls[1][0]).toContain("redis.call('TIME')");
    expect(evalMock.mock.calls[2][0]).toContain("redis.call('TIME')");
  });
});
