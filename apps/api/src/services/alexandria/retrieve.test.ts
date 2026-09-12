const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
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
    lock: vi.fn(),
    finalize: vi.fn(),
    billAdd: vi.fn(),
    report: vi.fn(),
  };
});
vi.mock("../../config", () => ({
  config: { USE_DB_AUTHENTICATION: true, FIRE_EXCHANGE_URL: "https://x" },
}));
vi.mock("../rate-limiter", () => ({ redisRateLimitClient: mocks.redis }));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
vi.mock("./access", () => ({ authorizeProviders: async () => undefined }));
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
    timeoutMs: 50000,
    ...overrides,
  });
const executions = () =>
  mocks.request.mock.calls.filter(([arg]) => arg.path === "/v1/retrieve");
const exchangeAnswers = (body: unknown, status = 200) =>
  mocks.request.mockImplementation(async arg =>
    arg.path.endsWith("/quote")
      ? { status: 200, body: { maximumCredits: 5 } }
      : { status, body },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.clear();
  mocks.lock.mockResolvedValue({ status: "locked", lockId: "held" });
  mocks.finalize.mockResolvedValue(true);
  mocks.billAdd.mockResolvedValue({});
  mocks.report.mockResolvedValue(true);
  exchangeAnswers(answer);
});

it("quotes, reserves, executes within budget, settles actual usage, records once, and replays", async () => {
  expect(await run()).toEqual({ status: 200, body: answer, fresh: true });
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

  expect(await run()).toEqual({ status: 200, body: answer, fresh: false });
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
  ["denied", 402],
  ["skipped", 503],
])(
  "does not execute after a %s hold and lets the same id retry",
  async (status, expected) => {
    mocks.lock.mockResolvedValueOnce({ status });
    expect((await run()).status).toBe(expected);
    expect(executions()).toHaveLength(0);
    expect(mocks.finalize).not.toHaveBeenCalled();
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
    fresh: true,
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
