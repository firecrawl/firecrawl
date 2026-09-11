import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  due: new Map<string, number>(),
  failPhase: "",
  quote: 3,
  queue: [] as string[],
  forward: vi.fn(),
  access: vi.fn(),
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
vi.mock("../../lib/exchange-provider-access", () => ({
  authorizeExchangeProviders: state.access,
}));
vi.mock("../queue-service", () => ({
  getRedisConnection: () => ({
    get: async (key: string) => state.keys.get(key) ?? null,
    zrangebyscore: async () =>
      [...state.due.entries()]
        .filter(([, due]) => due <= Date.now())
        .map(([key]) => key),
    zremrangebyscore: async () => 0,
    zrem: async (_index: string, key: string) => state.due.delete(key),
    eval: async (script: string, keyCount: number, ...values: any[]) => {
      const [key, second] = values;
      const args = values.slice(keyCount);
      if (script.includes("'ZSCORE'")) {
        if (!state.due.has(args[0]) || state.due.get(args[0])! > args[1])
          return 0;
        state.due.set(args[0], args[2]);
        return 1;
      }
      if (script.includes("'RPUSH'")) {
        if (state.keys.has(second)) return 0;
        if (state.failQueue) throw new Error("Queue unavailable");
        state.queue.push(args[0]);
        state.keys.set(second, "1");
        return 1;
      }
      if (script.includes("'DEL'")) {
        await state.cleanup(key);
        state.due.delete(key);
        return 1;
      }
      const record = JSON.parse(args[0]);
      if (script.includes("'NX'")) {
        if (state.keys.has(key)) return null;
        state.keys.set(key, args[0]);
        state.due.set(key, args[2]);
        return "OK";
      }
      if (state.failReplay && record.state === "complete")
        throw new Error("Replay storage failed");
      if (state.failPhase && record.reconciliation?.phase === state.failPhase)
        throw new Error("Checkpoint unavailable");
      state.keys.set(key, args[0]);
      if (args[2] === "pending") state.due.set(key, args[3]);
      else state.due.delete(key);
      return 1;
    },
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
vi.mock("../../controllers/auth", () => ({
  authenticateUser: vi.fn(),
  getACUCTeam: async () => ({ org_id: "org_a" }),
}));
vi.mock("../autumn/firebill", () => ({
  firebillConfigured: () => true,
  firebillFinalize: state.finalize,
}));
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
      ? Promise.resolve({ status: 200, body: { maximumCredits: state.quote } })
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
import { reconcileExchangeRequests } from "./reconcile";
import { exchangeRouter } from "../../routes/exchange";
import { exchangeScrapeController } from "../../controllers/v2/scrape-exchange";
import {
  processBillingBatch,
  queueBillingOperation,
} from "../billing/batch_billing";
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
  state.access.mockReset().mockResolvedValue(undefined);
  state.keys.clear();
  state.due.clear();
  state.failPhase = "";
  state.quote = 3;
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
it.each(["confirm", "release", "recover"])(
  "preserves the returned hold identity and partner token through %s",
  async outcome => {
    state.hold.mockResolvedValue({
      status: "locked",
      lockId: "returned-lock",
      operationToken: "partner-operation",
    });
    if (outcome === "release") {
      state.semaphore.mockRejectedValueOnce(new ConcurrencyQueueTimeoutError());
      expect((await send()).status).toBe(429);
      expect(state.forward).not.toHaveBeenCalled();
    } else if (outcome === "recover") {
      state.finalize.mockResolvedValueOnce(false);
      expect((await send()).status).toBe(503);
      await recover();
      expect((await send()).status).toBe(200);
      expect(state.forward).toHaveBeenCalledOnce();
      expect(state.finalize).toHaveBeenCalledTimes(2);
    } else {
      expect((await send()).status).toBe(200);
    }
    for (const [hold] of state.finalize.mock.calls) {
      expect(hold).toMatchObject({
        lockId: "returned-lock",
        externalRequestId: "partner-operation",
        action: outcome === "release" ? "release" : "confirm",
      });
    }
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
  expect(JSON.parse([...state.keys.values()][0])).toMatchObject({
    state: "pending",
    reconciliation: {
      phase: "reserve",
      lockId: expect.any(String),
      maximumCredits: 3,
      body: { requests: calls },
    },
  });
});
it("rejects reusing the same request ID for a different payload", async () => {
  await send();
  const second = await send("/exchange/retrieve", "same", {
    requests: [{ ...calls[0], options: { q: "different" } }],
  });
  expect(second.status).toBe(409);
  expect(state.forward).toHaveBeenCalledTimes(1);
});
it("supplies scrape IDs for ordinary clients while retaining explicit proxy IDs", async () => {
  expect(
    (await request(app).post("/exchange/retrieve").send({ requests: calls }))
      .status,
  ).toBe(400);
  const first = await request(app).post("/v2/scrape").send({ exchange: calls });
  expect(first.status).toBe(200);
  expect(first.headers["x-request-id"]).toBe("job");
  expect((await send("/v2/scrape", "job")).status).toBe(200);
  expect(state.forward).toHaveBeenCalledTimes(1);
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
  expect(
    [...state.keys.entries()]
      .filter(([key]) => key.startsWith("exchange:provider-request"))
      .map(([, value]) => JSON.parse(value)),
  ).toEqual([
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
    expect(state.log).not.toHaveBeenCalled();
  },
);
it.each([
  { searchZDR: "forced-zdr" },
  { searchZDR: "forced-anon" },
  { searchZDR: "forced" },
  { scrapeZDR: "forced" },
  { forceZDR: true },
])("blocks private contextual lookup before forwarding %j", async flags => {
  state.flags = { exchangeRetrieve: true, ...flags };
  const result = await request(app)
    .post("/exchange/skills/resolve")
    .send({ query: "private query", urls: ["https://example.com/private"] });
  expect(result.status).toBe(403);
  expect(state.forward).not.toHaveBeenCalled();
  expect(state.hold).not.toHaveBeenCalled();
});
it("allows contextual lookup when private search is optional", async () => {
  state.flags = { exchangeRetrieve: true, ...{ searchZDR: "allowed" } };
  expect(
    (
      await request(app)
        .post("/exchange/skills/resolve")
        .send({ query: "docs" })
    ).status,
  ).toBe(200);
  expect(state.forward).toHaveBeenCalledOnce();
  expect(state.hold).not.toHaveBeenCalled();
});
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

it.each([false, true])(
  "keeps confirmed provider charges when the ledger fails (mixed batch: %s)",
  async mixed => {
    expect((await send()).status).toBe(200);
    if (mixed)
      await queueBillingOperation(
        "team_a",
        5,
        7,
        { endpoint: "scrape" },
        false,
        true,
      );
    state.debit.mockRejectedValueOnce(new Error("Ledger acknowledgement lost"));
    await processBillingBatch();
    if (mixed)
      expect(state.refund).toHaveBeenCalledWith(
        expect.objectContaining({ value: 5 }),
      );
    else expect(state.refund).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect((await send()).status).toBe(200);
    expect(state.forward).toHaveBeenCalledTimes(1);
    expect(state.hold).toHaveBeenCalledTimes(1);
  },
);

it.each(["denied", "unsent"])(
  "reports reconciliation when safe retry cleanup fails after %s",
  async failure => {
    state.cleanup.mockRejectedValueOnce(new Error("Redis unavailable"));
    if (failure === "denied")
      state.hold.mockResolvedValueOnce({ status: "denied" });
    else
      state.forward.mockRejectedValueOnce(
        new ExchangeProxyError("unreachable", undefined, true),
      );
    const result = await send();
    expect(result.status).toBe(503);
    expect(result.body.error).toContain("reconciliation");
    expect((await send()).status).toBe(409);
    expect(state.hold).toHaveBeenCalledTimes(1);
    expect(state.queue).toHaveLength(0);
  },
);

it("exposes provider agreements through a free authenticated read proxy", async () => {
  state.flags.exchangeRetrieve = false;
  state.forward.mockResolvedValue({
    status: 200,
    body: { providers: [] },
    contentType: "application/json",
  });
  const result = await request(app).get("/exchange/provider-terms?surface=web");
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ providers: [] });
  expect(result.headers["cache-control"]).toBe("no-store");
  expect(state.forward).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/v1/provider-terms?surface=web" }),
  );
  expect(state.hold).not.toHaveBeenCalled();
});

it.each(["/exchange/retrieve", "/v2/scrape"])(
  "blocks unaccepted provider execution and billing through %s",
  async path => {
    state.access.mockResolvedValue({
      status: 403,
      body: { success: false, error: "Accept provider terms first." },
    });
    expect((await send(path)).status).toBe(403);
    expect(state.forward).not.toHaveBeenCalled();
    expect(state.hold).not.toHaveBeenCalled();
    state.access.mockResolvedValue(undefined);
    expect((await send(path)).status).toBe(200);
  },
);

const recover = async () => {
  for (const key of state.due.keys()) state.due.set(key, 0);
  await reconcileExchangeRequests();
};
it.each(["failQueue", "failReplay"] as const)(
  "preserves and recovers a confirmed request after %s without duplicate execution or billing",
  async failure => {
    state[failure] = true;
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(409);
    expect(JSON.parse([...state.keys.values()][0])).toMatchObject({
      state: "pending",
      reconciliation: {
        phase: "enqueue",
        holdConfirmed: true,
        credits: 3,
        receipt: expect.any(Object),
      },
    });
    state[failure] = false;
    await recover();
    expect((await send()).status).toBe(200);
    expect(state.forward).toHaveBeenCalledTimes(1);
    expect(state.finalize).toHaveBeenCalledTimes(1);
    expect(state.queue).toHaveLength(1);
  },
);
it("hands off billing even when the post-confirm checkpoint fails", async () => {
  state.failPhase = "enqueue";
  expect((await send()).status).toBe(200);
  expect(state.queue).toHaveLength(1);
  expect((await send()).status).toBe(200);
  expect(state.finalize).toHaveBeenCalledTimes(1);
});
it("never re-executes a provider with an unknown outcome during recovery", async () => {
  state.forward.mockRejectedValue(new ExchangeProxyError("timeout"));
  expect((await send()).status).toBe(502);
  await recover();
  expect((await send()).status).toBe(409);
  expect(state.forward).toHaveBeenCalledTimes(1);
});
it("rejects quotes above the per-call cap before reserving", async () => {
  state.quote = 101;
  expect((await send()).status).toBe(502);
  expect(state.hold).not.toHaveBeenCalled();
  expect(state.forward).not.toHaveBeenCalled();
});
it("does not refund delivered access-event charges after a ledger error", async () => {
  await queueBillingOperation(
    "team_a",
    3,
    7,
    { endpoint: "scrape" },
    false,
    true,
    { accessEventId: "access-1" },
  );
  state.debit.mockRejectedValueOnce(new Error("Ledger unavailable"));
  await processBillingBatch();
  expect(state.refund).not.toHaveBeenCalled();
});

it("still confirms Exchange delivery if the batch lock release fails", async () => {
  expect((await send()).status).toBe(200);
  state.cleanup.mockRejectedValueOnce(new Error("Redis release unavailable"));
  await processBillingBatch();
  expect(state.fetch).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "retains the hold identity when checkpoint and release fail (storage remains down: %s)",
  async storageDown => {
    state.hold.mockImplementationOnce(async () => {
      state.failPhase = "reserve";
      return {
        status: "locked",
        lockId: "returned-lock",
        operationToken: "partner-operation",
      };
    });
    state.finalize.mockImplementationOnce(async () => {
      if (!storageDown) state.failPhase = "";
      return false;
    });
    expect((await send()).status).toBe(503);
    expect(state.forward).not.toHaveBeenCalled();
    state.failPhase = "";
    await recover();
    expect(state.finalize).toHaveBeenCalledTimes(storageDown ? 1 : 2);
    if (storageDown)
      expect(JSON.parse([...state.keys.values()][0]).state).toBe("manual");
    for (const [hold] of state.finalize.mock.calls) {
      expect(hold).toMatchObject({
        lockId: "returned-lock",
        externalRequestId: "partner-operation",
        action: "release",
        customerId: "org_a",
      });
    }
  },
);
it.each([
  "invalid JSON",
  JSON.stringify({ state: "pending", reconciliation: { phase: "confirm" } }),
])(
  "quarantines malformed recovery state without retrying billing: %s",
  async raw => {
    state.keys.set("broken-request", raw);
    state.due.set("broken-request", 0);
    await recover();
    expect(JSON.parse(state.keys.get("broken-request")!).state).toBe("manual");
    expect(state.due.has("broken-request")).toBe(false);
    expect(state.finalize).not.toHaveBeenCalled();
    expect(state.debit).not.toHaveBeenCalled();
  },
);
