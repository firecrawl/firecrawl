const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    config: { USE_DB_AUTHENTICATION: true, FIRE_EXCHANGE_URL: "https://x" },
    redis: {
      set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes("NX") && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
    request: vi.fn(),
    authorize: vi.fn(),
    lock: vi.fn(),
    finalize: vi.fn(),
    refund: vi.fn(),
    billAdd: vi.fn(),
    report: vi.fn(),
  };
});
vi.mock("../../config", () => ({ config: mocks.config }));
vi.mock("../rate-limiter", () => ({ redisRateLimitClient: mocks.redis }));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("./access", () => ({ authorizeProviders: mocks.authorize }));
vi.mock("../queue-service", () => ({
  getBillingQueue: () => ({ add: mocks.billAdd }),
}));
vi.mock("../../lib/exchange", () => ({
  reportExchangeUsageBilling: mocks.report,
}));
vi.mock("../autumn/autumn.service", () => ({
  autumnService: {
    lockCredits: mocks.lock,
    finalizeCreditsLock: mocks.finalize,
    refundCredits: mocks.refund,
    isRoutedThroughFirebill: async () => false,
  },
  featureIdForBillingEndpoint: () => "credits",
}));
import { retrieveProviders } from "./retrieve";

const call = {
  provider: "fred",
  capability: "series/observations",
  options: { series_id: "GDP" },
};
const answer = {
  success: true,
  creditsCost: 3,
  results: [{ ...call, creditsCost: 3, data: {} }],
};
const run = (overrides: Record<string, unknown> = {}) =>
  retrieveProviders({
    teamId: "team",
    apiKeyId: 12,
    flags: {},
    calls: [call],
    requestId: "request-1",
    scrapeId: "scrape-1",
    timeoutMs: 50000,
    ...overrides,
  });
const executions = () =>
  mocks.request.mock.calls.filter(([arg]) => arg.path === "/v1/retrieve");
const exchangeAnswers = (
  body: unknown,
  status = 200,
  quote: unknown = { status: 200, body: { maximumCredits: 5 } },
) =>
  mocks.request.mockImplementation(async arg =>
    arg.path.endsWith("/quote") ? quote : { status, body },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.config.USE_DB_AUTHENTICATION = true;
  mocks.authorize.mockResolvedValue(undefined);
  mocks.lock.mockResolvedValue({ status: "locked", lockId: "held" });
  mocks.finalize.mockResolvedValue(true);
  mocks.refund.mockResolvedValue(undefined);
  mocks.billAdd.mockResolvedValue({});
  mocks.report.mockResolvedValue(true);
  exchangeAnswers(answer);
});

it("quotes, reserves, executes within budget, settles actual usage, records once, and replays", async () => {
  expect(await run()).toEqual({
    status: 200,
    body: answer,
    executed: true,
    scrapeId: "scrape-1",
  });
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({ value: 5, featureId: "credits" }),
  );
  expect(executions()[0][0]).toEqual(
    expect.objectContaining({
      maximumCredits: 5,
      requestId: expect.any(String),
    }),
  );
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({
      lockId: "held",
      action: "confirm",
      overrideValue: 3,
      heldValue: 5,
    }),
  );
  expect(mocks.billAdd).toHaveBeenCalledWith(
    "bill_team",
    expect.objectContaining({ credits: 3, autumnTrackInRequest: true }),
    expect.objectContaining({
      jobId: expect.stringMatching(/^alexandria-bill-/),
    }),
  );
  expect(mocks.report).toHaveBeenCalledWith(
    expect.objectContaining({ status: "confirmed" }),
  );

  // The replay keeps the original scrape id and executes nothing.
  expect(await run({ scrapeId: "scrape-2" })).toEqual({
    status: 200,
    body: answer,
    executed: false,
    scrapeId: "scrape-1",
  });
  expect(executions()).toHaveLength(1);
  expect(mocks.finalize).toHaveBeenCalledTimes(1);
  expect(mocks.billAdd).toHaveBeenCalledTimes(1);
});

it("refuses a different payload under the same x-request-id", async () => {
  await run();
  const other = await run({
    calls: [{ ...call, options: { series_id: "CPI" } }],
  });
  expect(other.status).toBe(409);
  expect(other.body).toEqual(
    expect.objectContaining({ code: "duplicate_request" }),
  );
  expect(executions()).toHaveLength(1);
});

it.each([
  [
    "authorization refusal",
    () => mocks.authorize.mockResolvedValueOnce({ status: 403, body: {} }),
    403,
  ],
  [
    "quote outage",
    () => exchangeAnswers(answer, 200, { status: 503, body: "down" }),
    503,
  ],
  [
    "malformed quote",
    () => exchangeAnswers(answer, 200, { status: 200, body: { nope: 1 } }),
    502,
  ],
  [
    "billing not configured",
    () => {
      mocks.config.USE_DB_AUTHENTICATION = false;
    },
    503,
  ],
  [
    "denied hold",
    () => mocks.lock.mockResolvedValueOnce({ status: "denied" }),
    402,
  ],
  [
    "skipped hold",
    () => mocks.lock.mockResolvedValueOnce({ status: "skipped" }),
    503,
  ],
])(
  "fails closed on %s and lets the same id retry",
  async (_, arrange, expected) => {
    arrange();
    const refused = await run();
    expect(refused.status).toBe(expected);
    expect(refused.executed).toBe(false);
    expect(executions()).toHaveLength(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.store.size).toBe(0);
    mocks.config.USE_DB_AUTHENTICATION = true;
    exchangeAnswers(answer);
    expect((await run()).status).toBe(200);
    expect(executions()).toHaveLength(1);
  },
);

it("holds an ambiguous execution for reconciliation without settling or re-executing", async () => {
  exchangeAnswers("gateway error", 502);
  const first = await run();
  expect(first.status).toBe(503);
  expect(first.body).toEqual(
    expect.objectContaining({ code: "request_unresolved" }),
  );
  expect(mocks.finalize).not.toHaveBeenCalled();

  exchangeAnswers(answer);
  expect((await run()).body).toEqual(
    expect.objectContaining({ code: "request_unresolved" }),
  );
  expect(executions()).toHaveLength(1);
  expect(mocks.billAdd).not.toHaveBeenCalled();
});

it("releases the hold on a definitive refusal and relays it without caching", async () => {
  exchangeAnswers(
    { code: "credit_budget_exceeded", error: "Over budget." },
    402,
  );
  expect(await run()).toEqual({
    status: 402,
    body: {
      success: false,
      code: "credit_budget_exceeded",
      error: "Over budget.",
    },
    executed: true,
    scrapeId: "scrape-1",
  });
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ lockId: "held", action: "release" }),
  );
  expect(mocks.store.size).toBe(0);
});

it("does not settle a receipt over budget", async () => {
  exchangeAnswers({
    ...answer,
    creditsCost: 6,
    results: [{ ...answer.results[0], creditsCost: 6 }],
  });
  expect((await run()).body).toEqual(
    expect.objectContaining({ code: "request_unresolved" }),
  );
  expect(mocks.finalize).not.toHaveBeenCalled();
  expect(mocks.billAdd).not.toHaveBeenCalled();
});

it("returns the answer but records nothing when the settle does not land", async () => {
  mocks.finalize.mockResolvedValueOnce(false);
  expect((await run()).status).toBe(200);
  expect(mocks.billAdd).not.toHaveBeenCalled();
  expect(mocks.report).not.toHaveBeenCalled();
});

it("refunds the direct-Autumn charge and leaves the Exchange usage pending when the ledger enqueue fails", async () => {
  mocks.billAdd.mockRejectedValue(new Error("queue down"));
  expect((await run()).status).toBe(200);
  expect(mocks.billAdd).toHaveBeenCalledTimes(3);
  expect(mocks.refund).toHaveBeenCalledWith(
    expect.objectContaining({ teamId: "team", value: 3 }),
  );
  expect(mocks.report).not.toHaveBeenCalled();
});
