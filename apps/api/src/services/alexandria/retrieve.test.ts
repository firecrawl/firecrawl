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
    plan: vi.fn(),
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
vi.mock("./client", () => ({
  exchangeRequest: mocks.request,
  exchangePlanTier: mocks.plan,
}));
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
    orgId: "org",
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
  mocks.plan.mockResolvedValue(undefined);
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
    expect.objectContaining({ value: 5, featureId: "credits", orgId: "org" }),
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
      team: { teamId: "team", orgId: "org" },
    }),
  );
  expect(mocks.billAdd).toHaveBeenCalledWith(
    "bill_team",
    expect.objectContaining({
      credits: 3,
      org_id: "org",
      autumnTrackInRequest: true,
    }),
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

it("sends the caller's plan on execution only when it is known", async () => {
  mocks.plan.mockResolvedValue("growth");
  await run();
  expect(mocks.plan).toHaveBeenCalledWith("team", "org");
  expect(executions()[0][0].plan).toBe("growth");

  mocks.store.clear();
  mocks.plan.mockResolvedValue(undefined);
  await run();
  expect(executions()[1][0]).not.toHaveProperty("plan");
});

it("relays a data source rate limit with its code and retry interval", async () => {
  mocks.request.mockImplementation(async arg =>
    arg.path.endsWith("/quote")
      ? { status: 200, body: { maximumCredits: 5 } }
      : {
          status: 429,
          retryAfter: "7",
          body: {
            code: "provider_rate_limited",
            error: "Slow down.",
            retryAfterSeconds: 7,
          },
        },
  );
  expect(await run()).toEqual({
    status: 429,
    retryAfter: "7",
    body: {
      success: false,
      code: "provider_rate_limited",
      error: "Slow down.",
      retryAfterSeconds: 7,
    },
    executed: true,
    scrapeId: "scrape-1",
  });
  expect(mocks.finalize).toHaveBeenCalledWith(
    expect.objectContaining({ action: "release" }),
  );
  expect(mocks.store.size).toBe(0);
});

it("lets the same x-request-id run again after an uncharged rate-limited batch", async () => {
  const limited = {
    success: true,
    creditsCost: 0,
    results: [
      {
        ...call,
        creditsCost: 0,
        error: {
          code: "provider_rate_limited",
          message: "Slow down.",
          status: 429,
          retryAfterSeconds: 12,
        },
      },
    ],
  };
  exchangeAnswers(limited);
  const first = await run();
  expect(first).toEqual(
    expect.objectContaining({ status: 200, body: limited, executed: true }),
  );
  expect(mocks.store.size).toBe(0);
  exchangeAnswers(answer);
  expect(await run()).toEqual(
    expect.objectContaining({ status: 200, body: answer, executed: true }),
  );
  expect(executions()).toHaveLength(2);
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
    expect.objectContaining({ teamId: "team", orgId: "org", value: 3 }),
  );
  expect(mocks.report).not.toHaveBeenCalled();
});

it("treats a team with no org as a skipped hold and executes nothing", async () => {
  const refused = await run({ orgId: null });
  expect(refused.status).toBe(503);
  expect(refused.executed).toBe(false);
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(executions()).toHaveLength(0);
  expect(mocks.store.size).toBe(0);
});

it.each([false, true])(
  "rejects mixed Bash source loading before side effects (Bash first: %s)",
  async bashFirst => {
    const bash = {
      provider: "firecrawl",
      capability: "bash",
      options: { requestId: "source", command: "ls" },
    };
    const result = await run({
      calls: bashFirst ? [bash, call] : [call, bash],
      resultAuthorization: "Bearer caller",
    });
    expect(result).toMatchObject({ status: 400, executed: false });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.store.size).toBe(0);
  },
);

it("allows standalone Bash source loading and forwards credentials only to execution", async () => {
  const bash = {
    provider: "firecrawl",
    capability: "bash",
    options: { requestId: "source", command: "ls" },
  };
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...bash, creditsCost: 0, data: { workspaceId: "workspace" } }],
  });
  const result = await run({
    calls: [bash],
    resultAuthorization: "Bearer caller",
  });
  expect(result).toMatchObject({ status: 200, executed: true });
  expect(executions()).toHaveLength(1);
  expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
  expect(
    mocks.request.mock.calls
      .filter(([arg]) => arg.path !== "/v1/retrieve")
      .every(([arg]) => arg.resultAuthorization === undefined),
  ).toBe(true);
  expect([...mocks.store.values()].join("")).not.toContain("Bearer caller");
});

it.each([
  {
    provider: "firecrawl",
    capability: "bash",
    options: { workspaceId: "workspace", command: "ls" },
  },
  {
    provider: "firecrawl",
    capability: "find-tools",
    options: { requestId: "source" },
  },
  { provider: "other", capability: "bash", options: { requestId: "source" } },
])("does not forward credentials for other calls: %j", async other => {
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [call, other].map(entry => ({
      ...entry,
      creditsCost: 0,
      data: {},
    })),
  });
  expect(
    await run({ calls: [call, other], resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 200, executed: true });
  expect(executions()[0][0].resultAuthorization).toBeUndefined();
});

it.each([123, null, false, {}, []])(
  "never forwards credentials for a non-string Bash requestId: %j",
  async requestId => {
    const bash = {
      provider: "firecrawl",
      capability: "bash",
      options: { requestId, command: "ls" },
    };
    exchangeAnswers(
      { success: false, error: "invalid option", code: "invalid_option" },
      400,
    );
    expect(
      await run({ calls: [call, bash], resultAuthorization: "Bearer caller" }),
    ).toMatchObject({ status: 400 });
    expect(executions()).toHaveLength(1);
    expect(executions()[0][0].resultAuthorization).toBeUndefined();
  },
);

it("forwards an optional version to quote and execution", async () => {
  const pinned = { ...call, version: "1.2.3" };
  await run({ calls: [pinned] });
  const forwarded = mocks.request.mock.calls.filter(
    ([r]) => r.path.endsWith("/quote") || r.path === "/v1/retrieve",
  );
  expect(forwarded).toHaveLength(2);
  for (const [request] of forwarded) {
    expect(request.body.requests).toEqual([pinned]);
  }
});

it("forwards verified terms identity only for terms-only executions", async () => {
  for (const capability of ["terms/show", "terms/accept"]) {
    mocks.store.clear();
    mocks.request.mockClear();
    const termsCall = {
      provider: "firecrawl",
      capability,
      options: { provider: "benzinga" },
    };
    exchangeAnswers({
      success: true,
      creditsCost: 0,
      results: [{ ...termsCall, creditsCost: 0, data: {} }],
    });
    await run({ calls: [termsCall], apiKeyIdText: "verified-key" });
    expect(executions()[0][0].termsIdentity).toEqual({
      organizationId: "org",
      apiKeyId: "verified-key",
    });
    expect(
      mocks.request.mock.calls
        .filter(([arg]) => arg.path !== "/v1/retrieve")
        .every(([arg]) => arg.termsIdentity === undefined),
    ).toBe(true);
  }
  for (const overrides of [
    {},
    { calls: [{ provider: "firecrawl", capability: "terms/show" }, call] },
    {
      calls: [{ provider: "firecrawl", capability: "terms/accept" }],
      orgId: null,
    },
    {
      calls: [{ provider: "firecrawl", capability: "terms/accept" }],
      apiKeyId: null,
    },
  ]) {
    mocks.store.clear();
    mocks.request.mockClear();
    exchangeAnswers(answer, 200, { status: 200, body: { maximumCredits: 0 } });
    await run(overrides);
    expect(executions()[0][0].termsIdentity).toBeUndefined();
  }
});

it("binds terms replay to exact organization and credential identity", async () => {
  const termsCall = {
    provider: "firecrawl",
    capability: "terms/accept",
    options: { provider: "benzinga" },
  };
  exchangeAnswers(
    {
      success: true,
      creditsCost: 0,
      results: [{ ...termsCall, creditsCost: 0, data: {} }],
    },
    200,
    { status: 200, body: { maximumCredits: 0 } },
  );
  const input = { calls: [termsCall], apiKeyIdText: "9007199254740993" };
  expect((await run(input)).executed).toBe(true);
  expect(executions()[0][0].termsIdentity.apiKeyId).toBe("9007199254740993");
  expect((await run(input)).executed).toBe(false);
  for (const change of [
    { apiKeyIdText: "9007199254740994" },
    { orgId: "other-org" },
    { apiKeyIdText: undefined },
  ]) {
    expect(await run({ ...input, ...change })).toMatchObject({
      status: 409,
      executed: false,
    });
  }
  expect(executions()).toHaveLength(1);
  expect(
    (
      await run({
        ...input,
        apiKeyIdText: "9007199254740994",
        requestId: "another-request",
      })
    ).executed,
  ).toBe(true);
});

it("does not derive terms credential identity from numeric API-key IDs", async () => {
  const termsCall = { provider: "firecrawl", capability: "terms/show" };
  exchangeAnswers(
    {
      success: true,
      creditsCost: 0,
      results: [{ ...termsCall, creditsCost: 0, data: {} }],
    },
    200,
    { status: 200, body: { maximumCredits: 0 } },
  );
  for (const apiKeyId of [12, Number("9007199254740993")]) {
    mocks.store.clear();
    const previousCount = executions().length;
    expect(await run({ calls: [termsCall], apiKeyId })).toMatchObject({
      executed: true,
    });
    expect(executions()).toHaveLength(previousCount + 1);
    const execution = executions().at(-1);
    if (!execution) throw new Error("Expected a provider execution");
    expect(execution[0].termsIdentity).toBeUndefined();
  }
});
