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
    mcpAvailable: vi.fn(),
    refundMcp: vi.fn(),
    billAdd: vi.fn(),
    report: vi.fn(),
    initCredits: vi.fn(),
    recordCredits: vi.fn(),
  };
});
vi.mock("../../lib/request-credits-store", () => ({
  AGENT_REQUEST_CREDITS_SHARDS: 8,
  initializeRequestCredits: mocks.initCredits,
  recordRequestCredits: mocks.recordCredits,
}));
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
    mcpCreditsAvailable: mocks.mcpAvailable,
    refundHostedMcpCredits: mocks.refundMcp,
    isRoutedThroughFirebill: async () => false,
  },
  featureIdForBillingEndpoint: () => "credits",
  MCP_CREDITS_FEATURE_ID: "mcp_credits",
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
    rateLimitMultiplier: 1,
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
  mocks.mcpAvailable.mockResolvedValue(0);
  mocks.refundMcp.mockResolvedValue(true);
  mocks.billAdd.mockResolvedValue({});
  mocks.report.mockResolvedValue(true);
  mocks.initCredits.mockResolvedValue(true);
  mocks.recordCredits.mockResolvedValue(true);
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
])("forwards credentials with execution for mixed calls: %j", async other => {
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
  expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
});

it.each([123, null, false, {}, []])(
  "forwards credentials with execution for a non-string Bash requestId: %j",
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
    expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
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

const sqlCall = {
  provider: "firecrawl",
  capability: "sql",
  options: { query: "SHOW TABLES IN apollo LIMIT 10" },
};
it("forwards standalone SQL credentials only to execution without retaining them", async () => {
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [
      { ...sqlCall, creditsCost: 0, data: { kind: "tables", items: [] } },
    ],
  });
  expect(
    await run({ calls: [sqlCall], resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 200, executed: true });
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
  { name: "SQL first", calls: [sqlCall, call] },
  { name: "SQL last", calls: [call, sqlCall] },
  { name: "two SQL calls", calls: [sqlCall, sqlCall] },
])("rejects batched SQL before side effects: $name", async ({ calls }) => {
  expect(
    await run({ calls, resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 400, executed: false });
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.store.size).toBe(0);
});
it("forwards credentials with execution for another provider's sql capability", async () => {
  const other = { ...sqlCall, provider: "other" };
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...other, creditsCost: 0, data: {} }],
  });
  expect(
    await run({ calls: [other], resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 200, executed: true });
  expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
});

const enrichmentCall = {
  provider: "firecrawl",
  capability: "enrich",
  options: { url: "https://ca.linkedin.com/in/example", format: "json" },
};
it("forwards standalone enrichment credentials only to execution without retaining them", async () => {
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [
      {
        ...enrichmentCall,
        creditsCost: 0,
        data: { status: "disabled", steps: [] },
      },
    ],
  });
  expect(
    await run({
      calls: [enrichmentCall],
      resultAuthorization: "Bearer caller",
    }),
  ).toMatchObject({ status: 200, executed: true });
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
  { name: "enrichment first", calls: [enrichmentCall, call] },
  { name: "enrichment last", calls: [call, enrichmentCall] },
  { name: "two enrichment calls", calls: [enrichmentCall, enrichmentCall] },
])(
  "rejects batched enrichment before side effects: $name",
  async ({ calls }) => {
    expect(
      await run({ calls, resultAuthorization: "Bearer caller" }),
    ).toMatchObject({ status: 400, executed: false });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.store.size).toBe(0);
  },
);
it("forwards credentials with execution for another provider's enrich capability", async () => {
  const other = { ...enrichmentCall, provider: "other" };
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...other, creditsCost: 0, data: {} }],
  });
  expect(
    await run({ calls: [other], resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 200, executed: true });
  expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
});

it("forwards credentials with execution for any provider, never to quote or authorization, and never retains them", async () => {
  const plain = {
    provider: "fred",
    capability: "series/observations",
    options: { series_id: "GDP" },
  };
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...plain, creditsCost: 0, data: {} }],
  });
  expect(
    await run({ calls: [plain], resultAuthorization: "Bearer caller" }),
  ).toMatchObject({ status: 200, executed: true });
  expect(executions()).toHaveLength(1);
  expect(executions()[0][0].resultAuthorization).toBe("Bearer caller");
  expect(
    mocks.request.mock.calls
      .filter(([arg]) => arg.path !== "/v1/retrieve")
      .every(([arg]) => arg.resultAuthorization === undefined),
  ).toBe(true);
  expect([...mocks.store.values()].join("")).not.toContain("Bearer caller");
});

it("sends no credentials when the caller supplied none", async () => {
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...call, creditsCost: 0, data: {} }],
  });
  expect(await run({ calls: [call] })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(executions()[0][0].resultAuthorization).toBeUndefined();
});

it("forwards zero data retention to quote and execution and keeps no response", async () => {
  expect(await run({ zeroDataRetention: true })).toEqual({
    status: 200,
    body: answer,
    executed: true,
    scrapeId: "scrape-1",
  });
  const forwarded = mocks.request.mock.calls.filter(
    ([r]) => r.path.endsWith("/quote") || r.path === "/v1/retrieve",
  );
  expect(forwarded).toHaveLength(2);
  for (const [request] of forwarded)
    expect(request.zeroDataRetention).toBe(true);
  const [stored] = [...mocks.store.values()].map(raw => JSON.parse(raw));
  expect(stored).toMatchObject({ phase: "done", responseWithheld: true });
  expect(stored).not.toHaveProperty("response");

  const replay = await run({ zeroDataRetention: true, scrapeId: "scrape-2" });
  expect(replay).toMatchObject({ status: 409, executed: false });
  expect(replay.body).toEqual(
    expect.objectContaining({ code: "response_not_retained" }),
  );
  expect(executions()).toHaveLength(1);
});

it("keeps and replays the response without zero data retention", async () => {
  await run();
  expect(
    mocks.request.mock.calls.every(([r]) => r.zeroDataRetention === undefined),
  ).toBe(true);
  const [stored] = [...mocks.store.values()].map(raw => JSON.parse(raw));
  expect(stored.response).toEqual({ status: 200, body: answer });
  expect(stored).not.toHaveProperty("responseWithheld");
  expect(await run()).toMatchObject({
    status: 200,
    body: answer,
    executed: false,
  });
});

it("refuses the same x-request-id with a different zero data retention setting", async () => {
  await run();
  const other = await run({ zeroDataRetention: true });
  expect(other.status).toBe(409);
  expect(other.body).toEqual(
    expect.objectContaining({ code: "duplicate_request" }),
  );
  expect(executions()).toHaveLength(1);
});

it("records an agent call's charge on the agent run, once, at Exchange's price", async () => {
  await run({ agentRequestId: "agent-run", zeroDataRetention: true });
  expect(mocks.initCredits).not.toHaveBeenCalled();
  expect(mocks.recordCredits).toHaveBeenCalledTimes(1);
  expect(mocks.recordCredits).toHaveBeenCalledWith({
    requestId: "agent-run",
    jobId: expect.stringMatching(/^alexandria:/),
    credits: 3,
  });

  await run({ agentRequestId: "agent-run", zeroDataRetention: true });
  expect(mocks.recordCredits).toHaveBeenCalledTimes(1);
});

it("records nothing on the agent run when nothing was charged", async () => {
  await run({ agentRequestId: "agent-run", bypassBilling: true });
  mocks.store.clear();
  mocks.finalize.mockResolvedValueOnce(false);
  await run({ agentRequestId: "agent-run" });
  mocks.store.clear();
  mocks.billAdd.mockRejectedValue(new Error("queue down"));
  await run({ agentRequestId: "agent-run" });
  expect(mocks.recordCredits).not.toHaveBeenCalled();
});

it("still answers when the agent run's credits cannot be recorded", async () => {
  mocks.recordCredits.mockRejectedValue(new Error("bigtable down"));
  expect(await run({ agentRequestId: "agent-run" })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(mocks.billAdd).toHaveBeenCalledTimes(1);
});

it("creates the agent run's credit row only when it is missing", async () => {
  mocks.recordCredits.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await run({ agentRequestId: "agent-run" });
  expect(mocks.initCredits).toHaveBeenCalledWith("agent-run", 8);
  expect(mocks.recordCredits).toHaveBeenCalledTimes(2);
});

it("does not retry the write when the credit store is unavailable", async () => {
  mocks.recordCredits.mockResolvedValue(false);
  mocks.initCredits.mockResolvedValue(false);
  expect(await run({ agentRequestId: "agent-run" })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(mocks.recordCredits).toHaveBeenCalledTimes(1);
});

describe("hosted MCP calls", () => {
  const hosted = (overrides: Record<string, unknown> = {}) =>
    run({ hostedMcp: true, ...overrides });
  const locks = () => mocks.lock.mock.calls.map(([arg]) => arg);
  const settles = () => mocks.finalize.mock.calls.map(([arg]) => arg);
  const billing = () => mocks.billAdd.mock.calls[0][1].billing;

  beforeEach(() => {
    mocks.lock.mockImplementation(async arg => ({
      status: "locked",
      lockId: arg.lockId,
    }));
  });

  it("holds and settles on the MCP credits alone when they cover the call", async () => {
    mocks.mcpAvailable.mockResolvedValue(5);
    expect((await hosted()).status).toBe(200);
    expect(mocks.mcpAvailable).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team", orgId: "org", value: 5 }),
    );
    expect(locks()).toEqual([
      expect.objectContaining({
        value: 5,
        featureId: "mcp_credits",
        lockId: expect.stringMatching(/_mcp$/),
      }),
    ]);
    expect(settles()).toEqual([
      expect.objectContaining({
        lockId: locks()[0].lockId,
        action: "confirm",
        overrideValue: 3,
        heldValue: 5,
        featureId: "mcp_credits",
      }),
    ]);
    expect(billing()).toEqual(
      expect.objectContaining({ hostedMcp: true, mcpCredits: 3 }),
    );
  });

  it("splits the hold and the settle, MCP credits first, when they cover part", async () => {
    mocks.mcpAvailable.mockResolvedValue(2);
    expect((await hosted()).status).toBe(200);
    expect(locks()).toEqual([
      expect.objectContaining({ value: 2, featureId: "mcp_credits" }),
      expect.objectContaining({ value: 3, featureId: "credits" }),
    ]);
    expect(settles()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureId: "mcp_credits",
          action: "confirm",
          overrideValue: 2,
          heldValue: 2,
        }),
        expect.objectContaining({
          featureId: "credits",
          action: "confirm",
          overrideValue: 1,
          heldValue: 3,
        }),
      ]),
    );
    expect(settles()).toHaveLength(2);
    expect(billing()).toEqual(
      expect.objectContaining({ hostedMcp: true, mcpCredits: 2 }),
    );
  });

  it("releases the regular hold when the MCP part pays the whole charge", async () => {
    mocks.mcpAvailable.mockResolvedValue(4);
    expect((await hosted()).status).toBe(200);
    expect(settles()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureId: "mcp_credits",
          overrideValue: 3,
          heldValue: 4,
        }),
        expect.objectContaining({ featureId: "credits", action: "release" }),
      ]),
    );
    expect(billing()).toEqual(expect.objectContaining({ mcpCredits: 3 }));
  });

  it("holds and settles on regular credits alone once the MCP credits are used up", async () => {
    expect((await hosted()).status).toBe(200);
    expect(locks()).toEqual([
      expect.objectContaining({ value: 5, featureId: "credits" }),
    ]);
    expect(settles()).toEqual([
      expect.objectContaining({ featureId: "credits", overrideValue: 3 }),
    ]);
    expect(billing()).not.toHaveProperty("mcpCredits");
  });

  it("hands the MCP hold back when the rest cannot be held", async () => {
    mocks.mcpAvailable.mockResolvedValue(2);
    mocks.lock
      .mockImplementationOnce(async arg => ({
        status: "locked",
        lockId: arg.lockId,
      }))
      .mockResolvedValueOnce({ status: "denied" });
    const refused = await hosted();
    expect(refused.status).toBe(402);
    expect(executions()).toHaveLength(0);
    expect(settles()).toEqual([
      expect.objectContaining({
        featureId: "mcp_credits",
        action: "release",
        heldValue: 2,
      }),
    ]);
  });

  it.each([
    ["the MCP part", "mcp_credits", 1, 0],
    ["the rest", "credits", 2, 2],
  ])(
    "records only what landed when %s does not settle",
    async (_, failing, credits, mcpCredits) => {
      mocks.mcpAvailable.mockResolvedValue(2);
      mocks.finalize.mockImplementation(async arg => arg.featureId !== failing);
      expect((await hosted({ agentRequestId: "agent-run" })).status).toBe(200);
      expect(mocks.billAdd).toHaveBeenCalledWith(
        "bill_team",
        expect.objectContaining({
          credits,
          billing: expect.objectContaining(
            mcpCredits > 0 ? { mcpCredits } : {},
          ),
        }),
        expect.anything(),
      );
      if (mcpCredits === 0) expect(billing()).not.toHaveProperty("mcpCredits");
      expect(mocks.recordCredits).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "agent-run", credits }),
      );
      expect(mocks.report).not.toHaveBeenCalled();
    },
  );

  it("releases both holds on a definitive refusal", async () => {
    mocks.mcpAvailable.mockResolvedValue(2);
    exchangeAnswers({ error: "nope" }, 400);
    expect((await hosted()).status).toBe(400);
    expect(settles()).toHaveLength(2);
    expect(settles().every(settle => settle.action === "release")).toBe(true);
  });

  it("refunds each part to its own balance when the ledger enqueue fails", async () => {
    mocks.mcpAvailable.mockResolvedValue(2);
    mocks.billAdd.mockRejectedValue(new Error("queue down"));
    expect((await hosted()).status).toBe(200);
    expect(mocks.refundMcp).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, mcpCredits: 2, orgId: "org" }),
    );
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("adds the MCP part of an agent call to the run's MCP tally", async () => {
    mocks.mcpAvailable.mockResolvedValue(2);
    await hosted({ agentRequestId: "agent-run" });
    expect(mocks.recordCredits).toHaveBeenCalledWith({
      requestId: "agent-run",
      jobId: expect.stringMatching(/^alexandria:/),
      credits: 3,
    });
    expect(mocks.recordCredits).toHaveBeenCalledWith({
      requestId: "agent-run:mcp",
      jobId: expect.stringMatching(/^alexandria:/),
      credits: 2,
    });
  });

  it("leaves a call not from the hosted MCP as it was", async () => {
    mocks.mcpAvailable.mockResolvedValue(5);
    expect((await run({ agentRequestId: "agent-run" })).status).toBe(200);
    expect(mocks.mcpAvailable).not.toHaveBeenCalled();
    expect(locks()).toEqual([
      expect.objectContaining({ value: 5, featureId: "credits" }),
    ]);
    expect(billing()).toEqual({
      endpoint: "scrape",
      chargeId: expect.any(String),
    });
    expect(mocks.recordCredits).toHaveBeenCalledTimes(1);
  });
});
