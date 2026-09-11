import { afterAll, beforeEach, expect, it, vi } from "vitest";
import Redis from "ioredis";
const state = vi.hoisted(() => ({
  finalize: vi.fn(),
  exitListeners: process.listeners("beforeExit"),
}));
const socket = process.env.TEST_EXCHANGE_REDIS_SOCKET;
const redis = socket
  ? new Redis(socket, { maxRetriesPerRequest: 1 })
  : undefined;
vi.mock("../queue-service", () => ({ getRedisConnection: () => redis }));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: { finalizeCreditsLock: state.finalize },
  featureIdForBillingEndpoint: () => "credits",
}));
vi.mock("../exchange/report", () => ({ reportExchangeUsageBilling: vi.fn() }));
vi.mock("../../lib/exchange", () => ({ reportExchangeBilling: vi.fn() }));
vi.mock("../../db/rpc", () => ({ billTeam7: vi.fn() }));
vi.mock("../../lib/withAuth", () => ({ withAuth: (fn: unknown) => fn }));
import {
  beginExchangeRequest,
  RECONCILIATION_KEY,
  MANUAL_RECONCILIATION_KEY,
  RECOVERY_DELAY_MS,
} from "./request-state";
import { reconcileExchangeRequests } from "./reconcile";
import { queueBillingOperation } from "../billing/batch_billing";
import { logger } from "../../lib/logger";
const testRedis = it.skipIf(!socket);
const response = {
  status: 200,
  body: { success: true, creditsCost: 2 },
  contentType: "application/json",
  requestId: "example",
};
beforeEach(async () => {
  if (!redis) return;
  // Only an explicitly provided, isolated Unix-socket test server is used.
  await redis.flushdb();
  state.finalize.mockReset().mockResolvedValue(true);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterAll(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const listener of process.listeners("beforeExit"))
    if (!state.exitListeners.includes(listener))
      process.removeListener("beforeExit", listener);
  await redis?.quit();
});
testRedis(
  "recovers a stored result across process state loss and atomically deduplicates ledger handoff",
  async () => {
    const input = {
      teamId: "test-team",
      requestId: "test-recovery",
      body: { provider: "test" },
      logger,
    };
    const request = await beginExchangeRequest(input);
    expect(request.response).toBeUndefined();
    await request.preserve!("confirm", {
      teamId: input.teamId,
      chargeId: request.chargeId,
      apiKeyId: 7,
      featureId: "credits",
      properties: {},
      maximumCredits: 3,
      lockId: "lock",
      credits: 2,
      response,
    });
    const keys = await redis!.zrange(RECONCILIATION_KEY, 0, -1);
    expect(keys).toHaveLength(1);
    expect(await redis!.ttl(keys[0])).toBeGreaterThan(0);
    await redis!.zadd(
      RECONCILIATION_KEY,
      Date.now() - RECOVERY_DELAY_MS,
      keys[0],
    );
    await reconcileExchangeRequests();
    expect(state.finalize).toHaveBeenCalledTimes(1);
    expect(await redis!.llen("billing_batch")).toBe(1);
    expect((await beginExchangeRequest(input)).response?.body).toEqual(
      response.body,
    );
    await queueBillingOperation(
      input.teamId,
      2,
      7,
      { endpoint: "scrape" },
      false,
      true,
      { usageRequestId: request.chargeId! },
    );
    expect(await redis!.llen("billing_batch")).toBe(1);
    expect(await redis!.zcard(RECONCILIATION_KEY)).toBe(0);
  },
);
testRedis(
  "admits one concurrent execution and atomically removes abandoned state from recovery",
  async () => {
    const input = {
      teamId: "test-team",
      requestId: "test-concurrent",
      body: { provider: "test" },
      logger,
    };
    const requests = await Promise.all(
      Array.from({ length: 8 }, () => beginExchangeRequest(input)),
    );
    expect(requests.filter(request => !request.response)).toHaveLength(1);
    expect(await redis!.zcard(RECONCILIATION_KEY)).toBe(1);
    await requests.find(request => !request.response)!.forget!();
    expect(await redis!.zcard(RECONCILIATION_KEY)).toBe(0);
    expect((await beginExchangeRequest(input)).response).toBeUndefined();
  },
);

testRedis(
  "retains unknown provider outcomes in the manual queue without retrying execution",
  async () => {
    const input = {
      teamId: "test-team",
      requestId: "unknown",
      body: { provider: "test" },
      logger,
    };
    const request = await beginExchangeRequest(input);
    await request.preserve!("executing", {
      teamId: input.teamId,
      chargeId: request.chargeId,
      apiKeyId: 7,
      featureId: "credits",
      properties: {},
      maximumCredits: 3,
      lockId: "lock",
      body: input.body,
    });
    const [key] = await redis!.zrange(RECONCILIATION_KEY, 0, -1);
    await redis!.zadd(RECONCILIATION_KEY, 0, key);
    await reconcileExchangeRequests();
    expect(await redis!.zrange(MANUAL_RECONCILIATION_KEY, 0, -1)).toEqual([
      key,
    ]);
    expect(JSON.parse((await redis!.get(key))!).state).toBe("manual");
    expect(await redis!.ttl(key)).toBeGreaterThan(0);
    expect((await beginExchangeRequest(input)).response?.status).toBe(409);
    expect(state.finalize).not.toHaveBeenCalled();
  },
);
