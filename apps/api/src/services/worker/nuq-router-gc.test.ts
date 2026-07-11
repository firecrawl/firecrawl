import { vi } from "vitest";

vi.mock("../../controllers/auth", () => ({
  getACUCTeam: vi.fn(),
}));

vi.mock("../../lib/deployment", () => ({
  isSelfHosted: vi.fn(() => false),
}));

vi.mock("./nuq", () => ({
  scrapeQueue: {},
  crawlFinishedQueue: {},
  crawlGroup: {},
  getNuQPgOwnerLiveResidue: vi.fn(),
}));

vi.mock("../../lib/concurrency-redis", () => ({
  constructConcurrencyLimitKey: vi.fn(),
  finalizeConcurrencyLimitActiveJobRollback: vi.fn(),
  getConcurrencyLimitActiveJobsCount: vi.fn(),
  getConcurrencyRollbackCleanupBacklog: vi.fn(),
  getTeamQueueLimit: vi.fn(),
  pushConcurrencyLimitActiveJob: vi.fn(),
  recoverConcurrencyLimitRollbacks: vi.fn(),
  removeConcurrencyLimitActiveJob: vi.fn(),
  renewConcurrencyLimitActiveJob: vi.fn(),
  reserveConcurrencyLimitActiveJob: vi.fn(),
  rollbackConcurrencyLimitActiveJob: vi.fn(),
}));

vi.mock("../../services/rate-limiter", () => ({
  redisRateLimitClient: { on: vi.fn() },
  getRateLimiter: vi.fn(),
}));

vi.mock("../../services/redis", () => ({
  redisEvictConnection: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  getValue: vi.fn(),
  setValue: vi.fn(),
  deleteKey: vi.fn(),
}));

vi.mock("../queue-service", () => ({
  getRedisConnection: () => ({
    eval: vi.fn(),
    zscore: vi.fn(),
    zrangebyscore: vi.fn(),
    zcard: vi.fn(),
    zcount: vi.fn(),
  }),
}));

import { sweepNuQMigrationGc, type NuQMigrationGcCategory } from "./nuq-router";

function scheduler(initial: Partial<Record<NuQMigrationGcCategory, number>>) {
  const due: Record<NuQMigrationGcCategory, number> = {
    terminal_pin: initial.terminal_pin ?? 0,
    control_history: initial.control_history ?? 0,
    closed_generation: initial.closed_generation ?? 0,
    redis_cleanup: initial.redis_cleanup ?? 0,
  };
  const calls: NuQMigrationGcCategory[] = [];
  const dependencies = {
    fdbEnabled: () => true,
    inspectFdb: vi.fn(async () => ({
      pin: { due: due.terminal_pin, oldestDueAt: 1, oldestOverdueMs: 10 },
      control: {
        due: due.control_history,
        oldestDueAt: due.control_history ? 1 : null,
        oldestOverdueMs: due.control_history ? 10 : 0,
      },
      generation: {
        due: due.closed_generation,
        oldestDueAt: due.closed_generation ? 1 : null,
        oldestOverdueMs: due.closed_generation ? 10 : 0,
      },
    })),
    inspectRedis: vi.fn(async () => ({
      total: due.redis_cleanup,
      due: due.redis_cleanup,
      oldestDueAt: due.redis_cleanup ? 1 : null,
      oldestOverdueMs: due.redis_cleanup ? 10 : 0,
    })),
    sweepCategory: vi.fn(
      async (category: NuQMigrationGcCategory, _now: number, limit: number) => {
        calls.push(category);
        const read = Math.min(limit, due[category]);
        due[category] -= read;
        return { read, removed: read, retained: 0, stale: 0 };
      },
    ),
  };
  return { dependencies, due, calls };
}

describe("NuQ migration GC work scheduler", () => {
  test("drains sustained arrivals above 100 per run with fair bounded pages", async () => {
    const fake = scheduler({ terminal_pin: 260, redis_cleanup: 230 });
    const result = await sweepNuQMigrationGc({
      dependencies: fake.dependencies,
      pageLimit: 100,
      maxPages: 32,
      workBudgetMs: 10_000,
      now: () => 1_000,
    });

    expect(result).toMatchObject({
      processed: 490,
      removed: 490,
      hasMore: false,
      stopReason: "idle",
    });
    expect(result.pages).toBe(6);
    expect(fake.calls).toEqual([
      "terminal_pin",
      "redis_cleanup",
      "terminal_pin",
      "redis_cleanup",
      "terminal_pin",
      "redis_cleanup",
    ]);
    expect(
      fake.dependencies.sweepCategory.mock.calls.every(call => call[2] <= 100),
    ).toBe(true);
  });

  test("one isolated replica exceeds the documented arrival target at representative page latency", async () => {
    const fake = scheduler({ terminal_pin: 10_000 });
    fake.dependencies.sweepCategory.mockImplementation(
      async (category: NuQMigrationGcCategory, _now: number, limit: number) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        fake.calls.push(category);
        const read = Math.min(limit, fake.due[category]);
        fake.due[category] -= read;
        return { read, removed: read, retained: 0, stale: 0 };
      },
    );

    const result = await sweepNuQMigrationGc({
      dependencies: fake.dependencies,
      pageLimit: 100,
      maxPages: 128,
      workBudgetMs: 10_000,
    });
    const rate = (result.processed * 1000) / result.elapsedMs;

    expect(result.processed).toBe(10_000);
    expect(result.hasMore).toBe(false);
    expect(rate).toBeGreaterThanOrEqual(2_000);
    expect(
      fake.dependencies.sweepCategory.mock.calls.every(call => call[2] <= 100),
    ).toBe(true);
  }, 15_000);

  test("page cap leaves exact backlog for a short retry", async () => {
    const fake = scheduler({ terminal_pin: 350 });
    const result = await sweepNuQMigrationGc({
      dependencies: fake.dependencies,
      pageLimit: 100,
      maxPages: 2,
      workBudgetMs: 10_000,
    });

    expect(result).toMatchObject({
      pages: 2,
      processed: 200,
      hasMore: true,
      stopReason: "page-cap",
      categories: { terminal_pin: { dueBacklog: 150 } },
    });
  });

  test("wall budget and abort bound work between pages", async () => {
    const fake = scheduler({ terminal_pin: 350 });
    let monotonic = 0;
    const budgeted = await sweepNuQMigrationGc({
      dependencies: fake.dependencies,
      pageLimit: 100,
      maxPages: 20,
      workBudgetMs: 15,
      monotonicNow: () => (monotonic += 10),
    });
    expect(budgeted).toMatchObject({
      pages: 1,
      processed: 100,
      hasMore: true,
      stopReason: "budget",
    });

    const controller = new AbortController();
    controller.abort();
    const aborted = await sweepNuQMigrationGc({
      dependencies: scheduler({ terminal_pin: 1 }).dependencies,
      signal: controller.signal,
      maxPages: 20,
      workBudgetMs: 10_000,
    });
    expect(aborted).toMatchObject({
      pages: 0,
      hasMore: true,
      stopReason: "aborted",
    });
  });

  test("idle and retained/rescheduled work do not hot loop", async () => {
    const idle = scheduler({});
    await expect(
      sweepNuQMigrationGc({
        dependencies: idle.dependencies,
        maxPages: 128,
        workBudgetMs: 10_000,
      }),
    ).resolves.toMatchObject({ pages: 0, hasMore: false, stopReason: "idle" });
    expect(idle.dependencies.sweepCategory).not.toHaveBeenCalled();

    const retained = scheduler({ closed_generation: 1 });
    retained.dependencies.sweepCategory.mockImplementationOnce(
      async (category: NuQMigrationGcCategory) => {
        retained.due[category]--;
        return { read: 1, removed: 0, retained: 1, stale: 0 };
      },
    );
    const result = await sweepNuQMigrationGc({
      dependencies: retained.dependencies,
      maxPages: 128,
      workBudgetMs: 10_000,
    });
    expect(result).toMatchObject({
      pages: 1,
      retained: 1,
      hasMore: false,
      stopReason: "idle",
    });
  });
});
