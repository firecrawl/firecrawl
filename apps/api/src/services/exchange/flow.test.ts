import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  queue: [] as string[],
  forward: vi.fn(),
  semaphore: vi.fn(),
  track: vi.fn(),
  hold: vi.fn(),
  finalize: vi.fn(),
  log: vi.fn(),
  debit: vi.fn(),
  refund: vi.fn(),
  fetch: vi.fn(),
  cleanup: vi.fn(),
  checkCredits: vi.fn(),
  flags: { exchangeRetrieve: true },
  failQueue: false,
  failReplay: false,
  exchangeAvailable: true,
}));
vi.mock("../queue-service", () => ({
  getRedisConnection: () => ({
    get: async (key: string) => state.keys.get(key) ?? null,
    set: async (key: string, value: string, ...args: unknown[]) => {
      if (state.failReplay && JSON.parse(value).state === "complete")
        throw new Error("Replay storage failed");
      if (args.includes("NX") && state.keys.has(key)) return null;
      state.keys.set(key, value);
      return "OK";
    },
    del: state.cleanup,
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
    checkCredits: state.checkCredits,
    lockCredits: state.hold,
    finalizeCreditsLock: state.finalize,
    trackCredits: state.track,
    refundCredits: state.refund,
    isRoutedThroughFirebill: async () => false,
  },
  featureIdForBillingEndpoint: () => "credits",
  CREDITS_FEATURE_ID: "credits",
}));
vi.mock("../autumn/usage", () => ({ getTeamBalance: vi.fn() }));
vi.mock("../../controllers/auth", () => ({ authenticateUser: vi.fn() }));
vi.mock("../idempotency/create", () => ({ createIdempotencyKey: vi.fn() }));
vi.mock("../idempotency/validate", () => ({ validateIdempotencyKey: vi.fn() }));
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
  forwardToExchange: (input: any) =>
    input.path === "/v1/retrieve/quote"
      ? Promise.resolve({ status: 200, body: { maximumCredits: 3 } })
      : state.forward(input),
  exchangeUpstreamBase: () =>
    state.exchangeAvailable ? "https://exchange.example" : null,
  exchangeProxyFailureResponse: () => ({
    status: 502,
    error: "Upstream unavailable",
  }),
  EXCHANGE_RETRIEVE_TIMEOUT_MS: 5000,
}));
vi.mock("../../routes/shared", async importOriginal => ({
  ...(await importOriginal<typeof import("../../routes/shared")>()),
  authMiddleware: () => (req: any, _res: any, next: any) => {
    req.auth = { team_id: "team_a" };
    req.acuc = { api_key_id: 7, flags: state.flags };
    next();
  },
  wrap: (fn: unknown) => fn,
}));
vi.mock("../logging/log_job", () => ({ logRequest: state.log }));
vi.mock("../../lib/external-request-id", () => ({
  externalRequestId: () => "external",
}));
import { exchangeRouter } from "../../routes/exchange";
import { exchangeScrapeController } from "../../controllers/v2/scrape-exchange";
import { processBillingBatch } from "../billing/batch_billing";
import { config } from "../../config";
import { ExchangeProxyError } from "../../lib/exchange-proxy";
import { ConcurrencyQueueTimeoutError } from "../../lib/error";
const originalConfig = {
  USE_DB_AUTHENTICATION: config.USE_DB_AUTHENTICATION,
  FIRE_EXCHANGE_URL: config.FIRE_EXCHANGE_URL,
  EXCHANGE_INTERNAL_SECRET: config.EXCHANGE_INTERNAL_SECRET,
  AGENT_INTEROP_SECRET: config.AGENT_INTEROP_SECRET,
};
afterEach(() => Object.assign(config, originalConfig));
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
  state.queue.length = 0;
  state.flags = { exchangeRetrieve: true };
  state.failQueue = false;
  state.failReplay = false;
  state.exchangeAvailable = true;
  state.cleanup
    .mockReset()
    .mockImplementation(async (key: string) => state.keys.delete(key));
  state.hold.mockReset().mockImplementation(async input => ({
    status: "locked",
    lockId: input.lockId,
  }));
  state.finalize.mockReset().mockResolvedValue(true);
  state.forward.mockReset().mockResolvedValue({
    status: 200,
    contentType: "application/json",
    requestId: "receipt",
    body: {
      success: true,
      creditsCost: 3,
      results: [{ ...calls[0], data: {}, creditsCost: 3 }],
    },
  });
  state.semaphore
    .mockReset()
    .mockImplementation(async (...args) => args.at(-1)());
  state.debit.mockReset().mockResolvedValue([{ api_key: "key" }]);
  state.refund.mockReset().mockResolvedValue(true);
  state.log.mockResolvedValue(undefined);
  state.fetch.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  config.USE_DB_AUTHENTICATION = true;
  config.FIRE_EXCHANGE_URL = "https://exchange.example";
  config.EXCHANGE_INTERNAL_SECRET = "test-secret";
  config.AGENT_INTEROP_SECRET = "agent-test-secret";
});
const send = (path = "/exchange/retrieve", id = "same", extra = {}) =>
  request(app)
    .post(path)
    .set("x-request-id", id)
    .send({
      ...(path === "/v2/scrape" ? { exchange: calls } : { requests: calls }),
      ...extra,
    });

it.each(["/exchange/retrieve", "/v2/scrape"])(
  "reserves before execution and charges once through %s",
  async path => {
    state.forward.mockImplementation(async input => {
      expect(state.hold).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 3,
          properties: expect.objectContaining({ apiKeyId: 7 }),
        }),
      );
      expect(input.maxCredits).toBe(3);
      return {
        status: 200,
        body: {
          success: true,
          creditsCost: 2,
          results: [{ ...calls[0], data: {}, creditsCost: 2 }],
        },
      };
    });
    expect((await send(path)).status).toBe(200);
    expect(state.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm",
        overrideValue: 2,
        heldValue: 3,
      }),
    );
    expect(state.track).not.toHaveBeenCalled();
    expect(state.queue).toHaveLength(1);
    await processBillingBatch();
    expect(state.debit).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 2 }),
    );
    expect(state.fetch).toHaveBeenCalledTimes(1);
  },
);
it.each(["denied", "skipped"])(
  "does not execute when a hold is %s",
  async status => {
    state.hold.mockResolvedValue({ status });
    for (const path of ["/exchange/retrieve", "/v2/scrape"])
      expect((await send(path)).status).toBe(status === "denied" ? 402 : 503);
    expect(state.forward).not.toHaveBeenCalled();
    expect(state.queue).toHaveLength(0);
  },
);
it("replays completed results across entry points without a second execution or charge", async () => {
  const first = await send();
  const retry = await send("/v2/scrape");
  expect(first.status).toBe(200);
  expect(retry.status).toBe(200);
  expect(retry.body.data.exchange).toEqual(first.body.results);
  expect(state.forward).toHaveBeenCalledTimes(1);
  expect(state.hold).toHaveBeenCalledTimes(1);
  expect(state.queue).toHaveLength(1);
});
it("keeps an uncertain credit hold from authorizing a retry", async () => {
  state.hold.mockResolvedValue({ status: "skipped" });
  state.finalize.mockResolvedValue(false);
  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(409);
  expect(state.forward).not.toHaveBeenCalled();
  expect(state.hold).toHaveBeenCalledTimes(1);
});
it("rejects reusing the same request ID for a different payload", async () => {
  await send();
  const second = await send("/exchange/retrieve", "same", {
    requests: [{ ...calls[0], options: { q: "different" } }],
  });
  expect(second.status).toBe(409);
  expect(state.forward).toHaveBeenCalledTimes(1);
});
it("requires request IDs on external execution calls", async () => {
  for (const path of ["/exchange/retrieve", "/v2/scrape"]) {
    expect(
      (
        await request(app)
          .post(path)
          .send(
            path === "/v2/scrape" ? { exchange: calls } : { requests: calls },
          )
      ).status,
    ).toBe(400);
  }
  expect(state.hold).not.toHaveBeenCalled();
  expect(state.forward).not.toHaveBeenCalled();
});
it("does not execute simultaneous retries twice", async () => {
  let finish!: (value: any) => void;
  const upstream = new Promise(resolve => {
    finish = resolve;
  });
  state.forward.mockReturnValue(upstream);
  const first = send().then(response => response);
  await vi.waitFor(() => expect(state.forward).toHaveBeenCalledTimes(1));
  expect((await send()).status).toBe(409);
  finish({
    status: 200,
    body: {
      success: true,
      creditsCost: 3,
      results: [{ ...calls[0], data: {}, creditsCost: 3 }],
    },
  });
  expect((await first).status).toBe(200);
  expect(state.queue).toHaveLength(1);
});
it.each([
  { success: false, creditsCost: 3, results: [] },
  { success: true, creditsCost: 3, results: "invalid" },
  { success: true, creditsCost: 3, results: [] },
  {
    success: true,
    creditsCost: 4,
    results: [{ ...calls[0], data: {}, creditsCost: 4 }],
  },
  {
    success: true,
    creditsCost: 3,
    results: [{ ...calls[0], data: {}, creditsCost: 1 }],
  },
])("releases the hold for an invalid response or charge: %j", async body => {
  state.forward.mockResolvedValue({ status: 200, body });
  expect((await send()).status).toBe(502);
  expect(state.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ action: "release" }),
  );
  expect(state.queue).toHaveLength(0);
});
it("does not charge again when billing confirmation is ambiguous", async () => {
  state.finalize.mockResolvedValue(false);
  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(409);
  expect([...state.keys.values()].map(value => JSON.parse(value))).toEqual([
    expect.objectContaining({
      state: "pending",
      reconciliation: expect.objectContaining({
        phase: "confirm",
        credits: 3,
        lockId: expect.any(String),
      }),
    }),
  ]);
  expect(state.finalize).toHaveBeenCalledTimes(1);
  expect(state.forward).toHaveBeenCalledTimes(1);
  expect(state.queue).toHaveLength(0);
});
it.each([true, false])(
  "retries transport errors only when execution was definitely unsent (%s)",
  async requestNotSent => {
    state.forward.mockRejectedValueOnce(
      new ExchangeProxyError("unreachable", undefined, requestNotSent),
    );
    expect((await send()).status).toBe(502);
    expect((await send()).status).toBe(requestNotSent ? 200 : 409);
    expect(state.forward).toHaveBeenCalledTimes(requestNotSent ? 2 : 1);
  },
);
it("releases a hold and permits a retry after a concurrency timeout", async () => {
  state.semaphore.mockRejectedValueOnce(new ConcurrencyQueueTimeoutError());
  expect((await send()).status).toBe(429);
  expect(state.forward).not.toHaveBeenCalled();
  expect(state.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ action: "release" }),
  );
  expect((await send()).status).toBe(200);
});
it("does not repeat an executed request after an enqueue failure", async () => {
  state.failQueue = true;
  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(409);
  expect([...state.keys.values()].map(value => JSON.parse(value))).toEqual([
    expect.objectContaining({
      state: "pending",
      reconciliation: expect.objectContaining({
        phase: "enqueue",
        holdConfirmed: true,
        credits: 3,
        receipt: expect.any(Object),
      }),
    }),
  ]);
  expect(state.forward).toHaveBeenCalledTimes(1);
});
it("retains pending reconciliation when completed replay storage fails", async () => {
  state.failReplay = true;
  expect((await send()).status).toBe(503);
  expect((await send()).status).toBe(409);
  expect(state.forward).toHaveBeenCalledTimes(1);
  expect(state.queue).toHaveLength(1);
  expect(JSON.parse([...state.keys.values()][0])).toMatchObject({
    state: "pending",
    reconciliation: { phase: "enqueue", credits: 3 },
  });
});
it.each(["/exchange/retrieve", "/v2/scrape"])(
  "honors authenticated no-bill calls at %s",
  async path => {
    const response = await send(path, "agent", {
      __agentInterop: {
        auth: "agent-test-secret",
        shouldBill: false,
        requestId: "agent",
      },
    });
    expect(response.status).toBe(200);
    expect(state.hold).not.toHaveBeenCalled();
    expect(state.queue).toHaveLength(0);
    expect(state.log).not.toHaveBeenCalled();
    expect(
      (
        await send(path, "forged", {
          __agentInterop: {
            auth: "wrong",
            shouldBill: false,
            requestId: "forged",
          },
        })
      ).status,
    ).toBe(403);
  },
);
it.each([{ scrapeZDR: "forced" }, { forceZDR: true }])(
  "rejects retention-ineligible execution before billing %j",
  async flags => {
    state.flags = { exchangeRetrieve: true, ...flags };
    for (const path of ["/exchange/retrieve", "/v2/scrape"])
      expect((await send(path)).status).toBe(403);
    expect(state.hold).not.toHaveBeenCalled();
    expect(state.forward).not.toHaveBeenCalled();
  },
);
it("keeps discovery free, scopes access from authentication and preserves Markdown", async () => {
  state.flags.exchangeRetrieve = false;
  state.forward.mockResolvedValue({
    status: 200,
    body: "# Particle",
    contentType: "text/markdown",
  });
  const result = await request(app)
    .get("/exchange/skills/particle/SKILL.md")
    .set("x-exchange-extended-catalog-access", "true");
  expect(result.status).toBe(200);
  expect(result.text).toBe("# Particle");
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(state.forward).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "/v1/skills/particle/SKILL.md",
      hasExtendedCatalogAccess: false,
    }),
  );
  expect(state.hold).not.toHaveBeenCalled();
});
