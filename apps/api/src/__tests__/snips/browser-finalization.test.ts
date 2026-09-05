import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { beforeEach, afterAll, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  config: { USE_DB_AUTHENTICATION: true },
  prepare: vi.fn(),
  transaction: vi.fn(),
  redis: null as any,
  track: vi.fn(),
  route: vi.fn(),
  prompt: vi.fn(),
  clear: vi.fn(),
  adjust: vi.fn(),
}));
vi.mock("../../config", () => ({ config: mock.config }));
vi.mock("../../db/connection", () => ({
  db: {
    transaction: mock.transaction,
    update: () => ({
      set: (values: any) => ({ where: () => mock.prepare(values) }),
    }),
  },
}));
vi.mock("../../services/queue-service", () => ({
  getRedisConnection: () => mock.redis,
}));
vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {
    trackCredits: mock.track,
    isRoutedThroughFirebill: mock.route,
  },
  featureIdForBillingEndpoint: () => "CREDITS",
}));
vi.mock("../../services/billing/batch_billing", () => ({
  startBillingBatchProcessing: vi.fn(),
}));
vi.mock("../../lib/browser-sessions", () => ({
  didBrowserSessionUsePrompt: mock.prompt,
  clearBrowserSessionPromptFlag: mock.clear,
}));
vi.mock("../../lib/keyless", () => ({ adjustKeylessCredits: mock.adjust }));
import { finalizeBrowserSession } from "../../lib/browser-session-finalization";
const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
const namespace = `test:browser-finalization:${randomUUID()}`;
const queue = `${namespace}:queue`;
const keys: string[] = [queue];
let row: any;
let updateFailure: Error | undefined;
let lockFailure: Error | undefined;
let commitFailure: Error | undefined;
let serial = Promise.resolve();
beforeEach(async () => {
  vi.clearAllMocks();
  mock.config.USE_DB_AUTHENTICATION = true;
  await redis.del(queue);
  row = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    team_id: "test-team",
    should_bill: true,
    request_id: null,
    credits_used: null,
    status: "active",
    ttl_total: 60,
    scrape_id: null,
  };
  keys.push(`browser_session:billing:${row.id}`);
  updateFailure = lockFailure = commitFailure = undefined;
  mock.prepare.mockImplementation(async values => {
    if (lockFailure) throw lockFailure;
    if (row.status === "active") row = { ...row, ...values };
  });
  mock.track.mockResolvedValue(true);
  mock.route.mockResolvedValue(true);
  mock.prompt.mockResolvedValue(true);
  mock.clear.mockResolvedValue(undefined);
  mock.adjust.mockResolvedValue(undefined);
  mock.redis = new Proxy(redis, {
    get(target, prop) {
      if (prop === "eval")
        return (
          script: string,
          count: number,
          key: string,
          _queue: string,
          payload: string,
        ) => target.eval(script, count, key, queue, payload);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  mock.transaction.mockImplementation(
    async (work: (tx: any) => Promise<any>) => {
      const previous = serial;
      let unlock!: () => void;
      serial = new Promise(resolve => {
        unlock = resolve;
      });
      await previous;
      try {
        if (lockFailure) throw lockFailure;
        let draft = { ...row };
        const tx = {
          select: () => ({
            from: () => ({
              where: () => ({
                for: async (kind: string) => {
                  expect(kind).toBe("update");
                  return [draft];
                },
              }),
            }),
          }),
          update: () => ({
            set: (values: any) => ({
              where: async () => {
                if (updateFailure) throw updateFailure;
                draft = { ...draft, ...values };
              },
            }),
          }),
        };
        const result = await work(tx);
        row = draft;
        if (commitFailure) throw commitFailure;
        return result;
      } finally {
        unlock();
      }
    },
  );
});
afterAll(async () => {
  await redis.del(...keys);
  await redis.quit();
});
it("queues once and persists completion", async () => {
  const result = await finalizeBrowserSession(row.id, 60000, 1);
  expect(row.credits_used).toBe(result.creditsBilled);
  expect(row.status).toBe("destroyed");
  expect(await redis.llen(queue)).toBe(1);
  const operation = JSON.parse((await redis.lindex(queue, 0))!);
  expect(operation.billing.chargeId).toBe(`browser-session:${row.id}`);
  expect(operation.autumnTrackInRequest).toBe(true);
});
it("retries a failed queue without tracking the charge again", async () => {
  await redis.set(queue, "wrong type");
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toThrow(
    "WRONGTYPE",
  );
  expect(row.credits_used).toBeNull();
  await redis.del(queue);
  await finalizeBrowserSession(row.id, 120000, null);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
  expect(
    JSON.parse((await redis.hget(keys[keys.length - 1], "plan"))!).durationMs,
  ).toBe(60000);
});
it("reconciles a queued charge after database persistence fails", async () => {
  const original = new Error("database update failed");
  updateFailure = original;
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  expect(row.credits_used).toBeNull();
  updateFailure = undefined;
  await finalizeBrowserSession(row.id, 120000, null);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
});
it("serializes concurrent DELETE and webhook finalization", async () => {
  const [first, second] = await Promise.all([
    finalizeBrowserSession(row.id, 60000, 1),
    finalizeBrowserSession(row.id, 120000, null),
  ]);
  expect(first.creditsBilled).toBe(second.creditsBilled);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
});
it("reconciles a lost queue acknowledgement using its atomic receipt", async () => {
  const original = new Error("queue reply lost");
  const base = mock.redis;
  mock.redis = new Proxy(base, {
    get(target, prop) {
      if (prop === "eval")
        return async (...args: any[]) => {
          await target.eval(...args);
          throw original;
        };
      return Reflect.get(target, prop);
    },
  });
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  mock.redis = base;
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
});
it("retries prompt cleanup after a committed charge without billing again", async () => {
  const original = new Error("prompt delete failed");
  mock.clear.mockRejectedValueOnce(original);
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
});
it("does not treat database lock failure as another caller completing billing", async () => {
  row.scrape_id = "scrape";
  lockFailure = new Error("database lock failed");
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(
    lockFailure,
  );
  expect(mock.adjust).not.toHaveBeenCalled();
  expect(mock.track).not.toHaveBeenCalled();
});
it("retains legacy tracking ambiguity without repeating its external charge", async () => {
  mock.route.mockResolvedValue(false);
  const original = new Error("tracking reply lost");
  mock.track.mockRejectedValueOnce(original);
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toThrow(
    "outcome is unknown",
  );
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(0);
});
it("retries idempotent tracking with the same charge key and pinned route", async () => {
  const original = new Error("tracking reply lost");
  mock.track.mockRejectedValueOnce(original);
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  await finalizeBrowserSession(row.id, 120000, null);
  expect(mock.track.mock.calls[0]).toEqual(mock.track.mock.calls[1]);
  expect(mock.track.mock.calls[1][1]).toEqual({
    throwOnError: true,
    requireFirebill: true,
  });
});
it("reconciles a lost database commit response without repeating a charge", async () => {
  commitFailure = new Error("commit reply lost");
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(
    commitFailure,
  );
  commitFailure = undefined;
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).toHaveBeenCalledTimes(1);
  expect(await redis.llen(queue)).toBe(1);
});
it("does not enqueue preview billing", async () => {
  row.team_id = "preview_test";
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).not.toHaveBeenCalled();
  expect(await redis.llen(queue)).toBe(0);
});

it("clears a failed pre-tracking marker write before retrying", async () => {
  mock.route.mockResolvedValue(false);
  const original = new Error("marker acknowledgement lost");
  const base = mock.redis;
  mock.redis = new Proxy(base, {
    get(target, prop) {
      if (prop === "hset")
        return async (...args: any[]) => {
          const result = await target.hset(...args);
          if (args[1] === "trackingStarted") throw original;
          return result;
        };
      return Reflect.get(target, prop);
    },
  });
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(original);
  expect(mock.track).not.toHaveBeenCalled();
  expect(
    await redis.hget(`browser_session:billing:${row.id}`, "trackingStarted"),
  ).toBeNull();
  mock.redis = base;
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).toHaveBeenCalledTimes(1);
});
it("keeps a persistent keyless receipt across billing retries", async () => {
  row.scrape_id = "scrape";
  updateFailure = new Error("database failed");
  await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toBe(
    updateFailure,
  );
  updateFailure = undefined;
  await finalizeBrowserSession(row.id, 60000, null);
  expect(mock.adjust).toHaveBeenCalledTimes(1);
});

it("does not enqueue billing with database authentication disabled", async () => {
  mock.config.USE_DB_AUTHENTICATION = false;
  await finalizeBrowserSession(row.id, 60000, 1);
  expect(mock.track).not.toHaveBeenCalled();
  expect(await redis.llen(queue)).toBe(0);
});
it("removes the receipt if RPUSH fails after the marker write", async () => {
  const username = `browser-test-${randomUUID()}`;
  const password = randomUUID();
  await redis.acl(
    "SETUSER",
    username,
    "on",
    `>${password}`,
    "~*",
    "+eval",
    "+type",
    "+hget",
    "+hset",
    "+hdel",
  );
  const limited = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    username,
    password,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableReadyCheck: false,
  });
  const base = mock.redis;
  mock.redis = new Proxy(base, {
    get(target, prop) {
      if (prop === "eval")
        return (
          script: string,
          count: number,
          key: string,
          _queue: string,
          payload: string,
        ) => limited.eval(script, count, key, queue, payload);
      return Reflect.get(target, prop);
    },
  });
  try {
    await expect(finalizeBrowserSession(row.id, 60000, 1)).rejects.toThrow();
    expect(
      await redis.hget(`browser_session:billing:${row.id}`, "queued"),
    ).toBeNull();
    expect(await redis.llen(queue)).toBe(0);
    mock.redis = base;
    await finalizeBrowserSession(row.id, 60000, 1);
    expect(mock.track).toHaveBeenCalledTimes(1);
    expect(await redis.llen(queue)).toBe(1);
  } finally {
    limited.disconnect();
    await redis.acl("DELUSER", username);
  }
});
