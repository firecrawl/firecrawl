import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  queue: [] as string[],
  forward: vi.fn(),
  semaphore: vi.fn(),
  track: vi.fn(),
  debit: vi.fn(),
  refund: vi.fn(),
  fetch: vi.fn(),
  flags: { exchangeRetrieve: true },
  failQueue: false,
}));
vi.mock("../queue-service", () => ({
  getRedisConnection: () => ({
    set: async (key: string, value: string) => {
      if (state.keys.has(key)) return null;
      state.keys.set(key, value);
      return "OK";
    },
    del: async (key: string) => state.keys.delete(key),
    rpush: async (_key: string, value: string) => {
      if (state.failQueue) throw new Error("Queue unavailable");
      state.queue.push(value);
      return state.queue.length;
    },
    llen: async () => state.queue.length,
    lpop: async () => state.queue.shift() ?? null,
  }),
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: {
    trackCredits: state.track,
    refundCredits: state.refund,
    isRoutedThroughFirebill: async () => false,
  },
  featureIdForBillingEndpoint: () => "credits",
}));
vi.mock("../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: async () => 2,
}));
vi.mock("../worker/team-semaphore", () => ({
  teamConcurrencySemaphore: { withSemaphore: state.semaphore },
}));
vi.mock("../../db/rpc", () => ({ billTeam7: state.debit }));
vi.mock("../../lib/withAuth", () => ({ withAuth: (fn: unknown) => fn }));
vi.mock("../../lib/exchange", () => ({ reportExchangeBilling: vi.fn() }));
vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: state.fetch,
}));
vi.mock("../../lib/exchange-proxy", async importOriginal => ({
  ...(await importOriginal<typeof import("../../lib/exchange-proxy")>()),
  forwardToExchange: state.forward,
  exchangeUpstreamBase: () => "https://exchange.example",
  exchangeProxyFailureResponse: () => ({
    status: 502,
    error: "Upstream unavailable",
  }),
  EXCHANGE_RETRIEVE_TIMEOUT_MS: 5000,
}));
vi.mock("../../routes/shared", () => ({
  authMiddleware: () => (req: any, _res: any, next: any) => {
    req.auth = { team_id: "team_a" };
    req.acuc = { api_key_id: 7, flags: state.flags };
    next();
  },
  checkCreditsMiddleware: () => (_req: any, _res: any, next: any) => next(),
  wrap: (fn: unknown) => fn,
}));
vi.mock("../logging/log_job", () => ({ logRequest: async () => {} }));
vi.mock("../../lib/external-request-id", () => ({
  externalRequestId: () => "external",
}));
import { exchangeRouter } from "../../routes/exchange";
import { exchangeScrapeController } from "../../controllers/v2/scrape-exchange";
import { processBillingBatch } from "../billing/batch_billing";
import { config } from "../../config";
import { ExchangeProxyError } from "../../lib/exchange-proxy";
import { ConcurrencyQueueTimeoutError } from "../../lib/error";
const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);
app.post("/v2/scrape", (req, res) => {
  (req as any).auth = { team_id: "team_a" };
  (req as any).acuc = { api_key_id: 7, flags: state.flags };
  return exchangeScrapeController(req as any, res, "job");
});
const calls = [{ provider: "test", capability: "price" }];
beforeEach(() => {
  vi.clearAllMocks();
  state.keys.clear();
  state.semaphore.mockImplementation(
    async (_team, _holder, _limit, _signal, _timeout, fn) => fn(false),
  );
  state.queue.length = 0;
  state.failQueue = false;
  state.flags = { exchangeRetrieve: true };
  config.FIRE_EXCHANGE_URL = "https://exchange.example";
  config.EXCHANGE_INTERNAL_SECRET = "test-secret";
  state.track.mockResolvedValue(true);
  state.debit.mockResolvedValue([]);
  state.refund.mockResolvedValue(true);
  state.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  state.forward.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      creditsCost: 3,
      results: [{ data: { value: 12 }, creditsCost: 3 }],
    },
    contentType: "application/json",
    requestId: null,
  });
});
it.each(["/exchange/retrieve", "/v2/scrape"])(
  "settles %s only after the queued debit commits",
  async path => {
    const payload =
      path === "/v2/scrape"
        ? { exchange: calls, timeout: 1500 }
        : { requests: calls };
    const response = await request(app)
      .post(path)
      .set("x-request-id", "flow-1")
      .set("x-exchange-team-id", "attacker")
      .send(payload);
    expect(response.status).toBe(200);
    expect(state.forward.mock.calls[0][0].deadline).toBeGreaterThan(
      Date.now() + 100,
    );
    expect(state.semaphore).toHaveBeenCalledWith(
      "team_a",
      expect.any(String),
      2,
      expect.any(AbortSignal),
      expect.any(Number),
      expect.any(Function),
    );
    expect(state.track).toHaveBeenCalledTimes(1);
    expect(state.track.mock.calls[0][0]).toMatchObject({
      teamId: "team_a",
      value: 3,
    });
    expect(state.queue).toHaveLength(1);
    expect(state.debit).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    const operation = JSON.parse(state.queue[0]);
    expect(operation.exchange_usage_request_id).toBe(
      state.forward.mock.calls[0][0].requestId,
    );
    await processBillingBatch();
    expect(state.debit).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: "team_a", credits: 3, api_key_id: 7 }),
    );
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual([
      {
        requestId: operation.exchange_usage_request_id,
        status: "confirmed",
        billingReference: operation.billing_reference,
      },
    ]);
  },
);
it("deduplicates concurrent calls across the two HTTP entry points", async () => {
  const results = await Promise.all([
    request(app)
      .post("/exchange/retrieve")
      .set("x-request-id", "same")
      .send({ requests: calls }),
    request(app)
      .post("/v2/scrape")
      .set("x-request-id", "same")
      .send({ exchange: calls }),
  ]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(state.forward).toHaveBeenCalledTimes(1);
  expect(state.track).toHaveBeenCalledTimes(1);
  expect(state.queue).toHaveLength(1);
});
it("does not confirm a failed database debit", async () => {
  await request(app)
    .post("/exchange/retrieve")
    .set("x-request-id", "debit-failure")
    .send({ requests: calls });
  state.debit.mockRejectedValue(new Error("Database unavailable"));
  await processBillingBatch();
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.refund).toHaveBeenCalledWith(
    expect.objectContaining({ value: 3 }),
  );
});
it("refunds a failed enqueue and blocks re-execution", async () => {
  state.failQueue = true;
  const send = () =>
    request(app)
      .post("/exchange/retrieve")
      .set("x-request-id", "queue-failure")
      .send({ requests: calls });
  expect((await send()).status).toBe(503);
  expect(state.refund).toHaveBeenCalledTimes(1);
  expect((await send()).status).toBe(409);
  expect(state.forward).toHaveBeenCalledTimes(1);
});
it.each([408, 500, 502, 504])(
  "blocks retries after ambiguous upstream status %i",
  async status => {
    state.forward.mockResolvedValue({
      status,
      body: { error: "Upstream failed" },
    });
    const send = () =>
      request(app)
        .post("/exchange/retrieve")
        .set("x-request-id", "ambiguous")
        .send({ requests: calls });
    expect((await send()).status).toBe(status);
    expect((await send()).status).toBe(409);
    expect(state.forward).toHaveBeenCalledTimes(1);
    expect(state.track).not.toHaveBeenCalled();
  },
);
it("does not repeat an ambiguous billing track after retry", async () => {
  state.track.mockRejectedValue(new Error("Connection closed after track"));
  const send = () =>
    request(app)
      .post("/exchange/retrieve")
      .set("x-request-id", "track-failure")
      .send({ requests: calls });
  expect((await send()).status).toBe(502);
  expect((await send()).status).toBe(409);
  expect(state.track).toHaveBeenCalledTimes(1);
  expect(state.queue).toHaveLength(0);
  expect(state.fetch).not.toHaveBeenCalled();
});

it.each([-1, 101, 1.5, undefined])(
  "rejects invalid charge %s before billing",
  async creditsCost => {
    state.forward.mockResolvedValue({ status: 200, body: { creditsCost } });
    const response = await request(app)
      .post("/exchange/retrieve")
      .send({ requests: calls });
    expect(response.status).toBe(502);
    expect(state.track).not.toHaveBeenCalled();
    expect(state.queue).toHaveLength(0);
  },
);
it("leaves failed confirmations pending after bounded retries", async () => {
  await request(app).post("/exchange/retrieve").send({ requests: calls });
  state.fetch.mockResolvedValue({
    ok: false,
    status: 503,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  await processBillingBatch();
  expect(state.debit).toHaveBeenCalledTimes(1);
  expect(state.fetch).toHaveBeenCalledTimes(3);
  expect(state.refund).not.toHaveBeenCalled();
});

it.each([true, false])(
  "retries a transport failure only when definitely unsent: %s",
  async requestNotSent => {
    state.forward.mockRejectedValueOnce(
      new ExchangeProxyError("unreachable", undefined, requestNotSent),
    );
    const send = () =>
      request(app)
        .post("/exchange/retrieve")
        .set("x-request-id", "transport")
        .send({ requests: calls });
    expect((await send()).status).toBe(502);
    expect((await send()).status).toBe(requestNotSent ? 200 : 409);
    expect(state.track).toHaveBeenCalledTimes(requestNotSent ? 1 : 0);
  },
);
it("allows retry after a concurrency wait expires without calling the provider", async () => {
  state.semaphore.mockRejectedValueOnce(new ConcurrencyQueueTimeoutError());
  const send = () =>
    request(app)
      .post("/exchange/retrieve")
      .set("x-request-id", "concurrency")
      .send({ requests: calls });
  expect((await send()).status).toBe(429);
  expect(state.forward).not.toHaveBeenCalled();
  expect(state.track).not.toHaveBeenCalled();
  expect((await send()).status).toBe(200);
});
