const mocks = vi.hoisted(() => {
  const store = new Map<string, string | Buffer>();
  return {
    store,
    config: { USE_DB_AUTHENTICATION: true, FIRE_EXCHANGE_URL: "https://x" },
    redis: {
      set: vi.fn(
        async (key: string, value: string | Buffer, ...args: unknown[]) => {
          if (args.includes("NX") && store.has(key)) return null;
          store.set(key, value);
          return "OK";
        },
      ),
      get: vi.fn(async (key: string) => store.get(key)?.toString() ?? null),
      getBuffer: vi.fn(async (key: string) =>
        store.has(key) ? Buffer.from(store.get(key)!) : null,
      ),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
    request: vi.fn(),
    authorize: vi.fn(),
    lock: vi.fn(),
    finalize: vi.fn(),
    refund: vi.fn(),
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
    hostedMcpFeatureId: async () => "MCP_CREDITS",
    finalizeCreditsLock: mocks.finalize,
    refundCredits: mocks.refund,
  },
  featureIdForBillingEndpoint: () => "credits",
}));
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { answerSchema } from "./contracts";
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
const RECORD = "alexandria:retrieve:";
const RESPONSE = "alexandria:response:";
const storedUnder = (prefix: string) =>
  [...mocks.store].filter(([key]) => key.startsWith(prefix));
/** Every replay record in the store. */
const records = () =>
  storedUnder(RECORD).map(([, raw]) => JSON.parse(raw.toString()));
/** Every cached response in the store. */
const cachedResponses = () =>
  storedUnder(RESPONSE).map(([, raw]) =>
    JSON.parse(gunzipSync(Buffer.from(raw)).toString()),
  );
const everythingStored = () => JSON.stringify([records(), cachedResponses()]);
/** Rewrites the one stored record as a completed record that does not carry its response. */
const dropStoredResponse = () => {
  const [[key]] = storedUnder(RECORD);
  const { response, ...record } = records()[0];
  mocks.store.set(key, JSON.stringify(record));
  return { id: key.slice(RECORD.length), response };
};
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
      autumnTrackInRequest: false,
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

it("holds and settles a hosted MCP call's whole budget on MCP credits", async () => {
  expect(await run({ hostedMcp: true })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(mocks.lock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ value: 5, featureId: "MCP_CREDITS" }),
  );
  expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      overrideValue: 3,
      heldValue: 5,
      featureId: "MCP_CREDITS",
    }),
  );
  expect(mocks.billAdd).toHaveBeenCalledWith(
    "bill_team",
    expect.objectContaining({
      credits: 3,
      billing: expect.objectContaining({ hostedMcp: true }),
    }),
    expect.anything(),
  );
});

it("holds a hosted MCP call MCP credits refuse on the team's own credits", async () => {
  mocks.lock
    .mockResolvedValueOnce({ status: "denied" })
    .mockResolvedValueOnce({ status: "locked", lockId: "held" });
  mocks.billAdd.mockRejectedValue(new Error("queue down"));

  expect((await run({ hostedMcp: true })).status).toBe(200);
  expect(mocks.lock.mock.calls.map(([hold]) => hold.featureId)).toEqual([
    "MCP_CREDITS",
    "credits",
  ]);
  expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ featureId: "credits" }),
  );
  expect(mocks.billAdd).toHaveBeenCalledWith(
    "bill_team",
    expect.objectContaining({
      billing: expect.not.objectContaining({ hostedMcp: true }),
    }),
    expect.anything(),
  );
  expect(mocks.refund).not.toHaveBeenCalled();
});

it("reports billing unavailable when the team-credit fallback hold can't be placed", async () => {
  mocks.lock
    .mockResolvedValueOnce({ status: "denied", reason: "out_of_credits" })
    .mockResolvedValueOnce({ status: "denied", reason: "gate_unavailable" });

  const refused = await run({ hostedMcp: true });
  expect(refused).toMatchObject({ status: 503, executed: false });
  expect(executions()).toHaveLength(0);
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

it("keeps the charge and leaves the Exchange usage pending when the ledger enqueue fails", async () => {
  mocks.billAdd.mockRejectedValue(new Error("queue down"));
  expect((await run()).status).toBe(200);
  expect(mocks.billAdd).toHaveBeenCalledTimes(3);
  expect(mocks.refund).not.toHaveBeenCalled();
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
  expect(everythingStored()).not.toContain("Bearer caller");
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

it("names the billing organization only on execution, and only when it is known", async () => {
  await run();
  expect(executions()[0][0].billingOrganizationId).toBe("org");
  expect(executions()[0][0].termsIdentity).toBeUndefined();
  expect(
    mocks.request.mock.calls
      .filter(([arg]) => arg.path !== "/v1/retrieve")
      .every(([arg]) => arg.billingOrganizationId === undefined),
  ).toBe(true);

  mocks.store.clear();
  mocks.request.mockClear();
  exchangeAnswers(
    {
      success: true,
      creditsCost: 0,
      results: [{ ...call, creditsCost: 0, data: {} }],
    },
    200,
    { status: 200, body: { maximumCredits: 0 } },
  );
  expect(await run({ orgId: null })).toMatchObject({ executed: true });
  expect(executions()[0][0]).not.toHaveProperty("billingOrganizationId");
});

it("keeps the billing organization out of the request fingerprint", async () => {
  expect((await run()).executed).toBe(true);
  expect(await run({ orgId: "other-org" })).toMatchObject({
    status: 200,
    executed: false,
  });
  expect(executions()).toHaveLength(1);
});

it("leaves the billing organization off the catalogue read", async () => {
  const read = { provider: "firecrawl", capability: "find-tools", options: {} };
  exchangeAnswers({
    success: true,
    creditsCost: 0,
    results: [{ ...read, creditsCost: 0, data: {} }],
  });
  expect(await run({ calls: [read] })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(executions()[0][0]).not.toHaveProperty("billingOrganizationId");
});

it.each(["find-tools", "library"])(
  "sends a free %s read straight to execution: no agreement lookup, quote or hold",
  async capability => {
    const read = { provider: "firecrawl", capability, options: {} };
    const free = {
      success: true,
      creditsCost: 0,
      results: [{ ...read, creditsCost: 0, data: {} }],
    };
    exchangeAnswers(free);
    expect(await run({ calls: [read] })).toMatchObject({
      status: 200,
      executed: true,
      body: free,
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(executions()[0][0]).toMatchObject({
      body: { requests: [read] },
      maximumCredits: 0,
    });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.billAdd).not.toHaveBeenCalled();
    // The same x-request-id replays the recorded answer without a second read.
    expect(await run({ calls: [read] })).toMatchObject({
      status: 200,
      body: free,
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  },
);

it("runs a library read through the full path when Exchange prices it", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  const priced = {
    success: true,
    creditsCost: 2,
    results: [{ ...read, creditsCost: 2, data: {} }],
  };
  mocks.request.mockImplementation(async arg =>
    arg.path.endsWith("/quote")
      ? { status: 200, body: { maximumCredits: 2 } }
      : arg.maximumCredits === 0
        ? { status: 402, body: { code: "credit_budget_exceeded" } }
        : { status: 200, body: priced },
  );
  expect(await run({ calls: [read] })).toMatchObject({
    status: 200,
    executed: true,
    body: priced,
  });
  expect(mocks.authorize).toHaveBeenCalledTimes(1);
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({ value: 2 }),
  );
  expect(executions()).toHaveLength(2);
});

it("keeps a library read sent beside a paid call on the full path", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  exchangeAnswers({
    success: true,
    creditsCost: 3,
    results: [
      { ...call, creditsCost: 3, data: {} },
      { ...read, creditsCost: 0, data: {} },
    ],
  });
  expect(await run({ calls: [call, read] })).toMatchObject({
    status: 200,
    executed: true,
  });
  expect(mocks.authorize).toHaveBeenCalledTimes(1);
  expect(
    mocks.request.mock.calls.some(([arg]) => arg.path.endsWith("/quote")),
  ).toBe(true);
  expect(mocks.lock).toHaveBeenCalledTimes(1);
});

it("leaves a library read to the full path when the organization turned Firecrawl data off", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  exchangeAnswers(
    {
      success: true,
      creditsCost: 0,
      results: [{ ...read, creditsCost: 0, data: {} }],
    },
    200,
    { status: 200, body: { maximumCredits: 0 } },
  );
  await run({
    calls: [read],
    flags: {
      organizationDataSourceAccess: { firecrawl: { status: "disabled" } },
    },
  });
  expect(mocks.authorize).toHaveBeenCalledTimes(1);
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
  expect(everythingStored()).not.toContain("Bearer caller");
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
  expect(everythingStored()).not.toContain("Bearer caller");
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
  expect(everythingStored()).not.toContain("Bearer caller");
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
  const [stored] = records();
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
  const [stored] = records();
  expect(stored.response).toEqual({ status: 200, body: answer });
  expect(stored).not.toHaveProperty("responseWithheld");
  expect(await run()).toMatchObject({
    status: 200,
    body: answer,
    executed: false,
  });
});

it("records when the request completed", async () => {
  const before = Date.now();
  await run();
  expect(records()[0].doneAt).toBeGreaterThanOrEqual(before);
});

it("replays a response from the cache when the record does not carry it", async () => {
  const unicode = {
    ...answer,
    results: [{ ...call, creditsCost: 3, data: { note: "café ☃ 日本語" } }],
  };
  exchangeAnswers(unicode);
  await run();
  const { id, response } = dropStoredResponse();
  mocks.store.set(RESPONSE + id, gzipSync(JSON.stringify(response)));

  expect(await run({ scrapeId: "scrape-2" })).toEqual({
    status: 200,
    body: unicode,
    executed: false,
    scrapeId: "scrape-1",
  });
  expect(executions()).toHaveLength(1);
});

it("treats a cached response it cannot read as one it does not have", async () => {
  await run();
  const { id } = dropStoredResponse();
  mocks.store.set(RESPONSE + id, Buffer.from("not gzip"));

  const repeat = await run({ scrapeId: "scrape-2" });
  expect(repeat).toMatchObject({ status: 409, executed: false });
  expect(repeat.body).toEqual(
    expect.objectContaining({ code: "response_not_retained" }),
  );
  expect(executions()).toHaveLength(1);
});

it("fails a repeat whose cached response cannot be read, so the same id can be retried", async () => {
  await run();
  const { id, response } = dropStoredResponse();
  mocks.store.set(RESPONSE + id, gzipSync(JSON.stringify(response)));
  mocks.redis.getBuffer.mockRejectedValueOnce(new Error("Redis unavailable"));

  await expect(run()).rejects.toThrow("Redis unavailable");
  expect(await run()).toMatchObject({
    status: 200,
    body: answer,
    executed: false,
  });
  expect(executions()).toHaveLength(1);
});

it("refuses a repeat whose response is no longer kept, without running it again", async () => {
  await run();
  dropStoredResponse();

  const repeat = await run({ scrapeId: "scrape-2" });
  expect(repeat).toMatchObject({ status: 409, executed: false });
  expect(repeat.body).toEqual(
    expect.objectContaining({ code: "response_not_retained" }),
  );
  expect(executions()).toHaveLength(1);
});

describe("providers whose responses are not kept", () => {
  const particle = {
    provider: "particle",
    capability: "podcasts/transcript",
    options: { episode_id: "e1" },
  };
  const apollo = {
    provider: "apollo",
    capability: "people/match",
    options: { email: "a@example.com" },
  };
  const notRetained = (provider: string, capability: string) => ({
    provider,
    capability,
    error: expect.objectContaining({
      code: "response_not_retained",
      status: 409,
    }),
  });
  const stored = () => records()[0];
  const charges = () => ({
    executions: executions().length,
    confirms: mocks.finalize.mock.calls.length,
    ledger: mocks.billAdd.mock.calls.length,
  });

  it.each([
    ["Particle", particle],
    ["Apollo", apollo],
  ])(
    "keeps no %s data in the record and replays a coded error without charging again",
    async (_name, restricted) => {
      const answered = {
        success: true,
        creditsCost: 4,
        results: [
          {
            ...restricted,
            creditsCost: 4,
            data: { secret: "provider body" },
          },
        ],
      };
      exchangeAnswers(answered);
      expect(await run({ calls: [restricted] })).toEqual({
        status: 200,
        body: answered,
        executed: true,
        scrapeId: "scrape-1",
      });
      const record = stored();
      expect(record).toMatchObject({
        phase: "done",
        lockId: "held",
        maximumCredits: 5,
      });
      expect(JSON.stringify(record)).not.toContain("provider body");
      expect(record.response.body).toEqual({
        success: true,
        creditsCost: 4,
        results: [notRetained(restricted.provider, restricted.capability)],
      });
      const before = charges();
      expect(before).toEqual({ executions: 1, confirms: 1, ledger: 1 });

      const replay = await run({ calls: [restricted], scrapeId: "scrape-2" });
      expect(replay).toMatchObject({ status: 200, executed: false });
      expect(answerSchema.safeParse(replay.body).success).toBe(true);
      expect(JSON.stringify(replay)).not.toContain("provider body");
      expect(charges()).toEqual(before);
    },
  );

  it("strips only the restricted entries of a mixed batch and replays the rest", async () => {
    const calls = [call, particle, apollo];
    const answered = {
      success: true,
      creditsCost: 5,
      results: [
        { ...call, creditsCost: 3, data: { kept: "fred data" } },
        { ...particle, creditsCost: 1, data: { secret: "particle body" } },
        { ...apollo, creditsCost: 1, data: { secret: "apollo body" } },
      ],
    };
    exchangeAnswers(answered);
    expect(await run({ calls })).toMatchObject({
      status: 200,
      body: answered,
      executed: true,
    });
    const record = stored();
    expect(JSON.stringify(record)).not.toMatch(/particle body|apollo body/);
    const replayed = {
      success: true,
      creditsCost: 5,
      results: [
        answered.results[0],
        notRetained("particle", "podcasts/transcript"),
        notRetained("apollo", "people/match"),
      ],
    };
    expect(record.response.body).toEqual(replayed);
    const before = charges();

    const replay = await run({ calls });
    expect(replay).toMatchObject({
      status: 200,
      body: replayed,
      executed: false,
    });
    expect(answerSchema.safeParse(replay.body).success).toBe(true);
    expect(charges()).toEqual(before);
  });

  it.each(["enrich", "enrich/auto", "enrich/waterfall", "search/auto"])(
    "keeps no firecrawl %s data in the record and replays a coded error without charging again",
    async capability => {
      const enrich = {
        provider: "firecrawl",
        capability,
        options: { find: ["work_email"], subjects: [{ full_name: "A B" }] },
      };
      const answered = {
        success: true,
        creditsCost: 4,
        results: [
          {
            ...enrich,
            creditsCost: 4,
            data: {
              results: [{ served_by: "apollo", record: { email: "enriched" } }],
            },
          },
        ],
      };
      exchangeAnswers(answered);
      expect(await run({ calls: [enrich] })).toMatchObject({
        status: 200,
        body: answered,
        executed: true,
      });
      const record = stored();
      expect(record).toMatchObject({ phase: "done", maximumCredits: 5 });
      expect(JSON.stringify(record)).not.toContain("enriched");
      expect(record.response.body).toEqual({
        success: true,
        creditsCost: 4,
        results: [notRetained("firecrawl", capability)],
      });
      const before = charges();
      expect(before).toEqual({ executions: 1, confirms: 1, ledger: 1 });

      const replay = await run({ calls: [enrich], scrapeId: "scrape-2" });
      expect(replay).toMatchObject({ status: 200, executed: false });
      expect(answerSchema.safeParse(replay.body).success).toBe(true);
      expect(JSON.stringify(replay)).not.toContain("enriched");
      expect(charges()).toEqual(before);
    },
  );

  it.each([
    { provider: "acme", capability: "enrich" },
    { provider: "acme", capability: "search/auto" },
    { provider: "firecrawl", capability: "search" },
  ])("keeps $provider $capability whole", async identity => {
    const other = { ...identity, options: {} };
    const answered = {
      success: true,
      creditsCost: 2,
      results: [{ ...other, creditsCost: 2, data: { kept: true } }],
    };
    exchangeAnswers(answered);
    await run({ calls: [other] });
    expect(stored().response).toEqual({ status: 200, body: answered });
  });

  it("keeps an unrestricted provider's response whole and replays it without charging again", async () => {
    await run();
    expect(stored().response).toEqual({ status: 200, body: answer });
    const before = charges();
    expect(await run()).toMatchObject({
      status: 200,
      body: answer,
      executed: false,
    });
    expect(charges()).toEqual(before);
  });

  it("withholds a restricted provider's response under zero data retention as before", async () => {
    exchangeAnswers({
      success: true,
      creditsCost: 4,
      results: [{ ...particle, creditsCost: 4, data: { secret: "x" } }],
    });
    await run({ calls: [particle], zeroDataRetention: true });
    const record = stored();
    expect(record).toMatchObject({ phase: "done", responseWithheld: true });
    expect(record).not.toHaveProperty("response");
    const before = charges();
    const replay = await run({ calls: [particle], zeroDataRetention: true });
    expect(replay).toMatchObject({ status: 409, executed: false });
    expect(replay.body).toEqual(
      expect.objectContaining({ code: "response_not_retained" }),
    );
    expect(charges()).toEqual(before);
  });
});

it("forwards Alexandria Verified to quote and execution", async () => {
  await run({ flags: { alexandriaVerified: true } });
  const forwarded = mocks.request.mock.calls.filter(
    ([r]) => r.path.endsWith("/quote") || r.path === "/v1/retrieve",
  );
  expect(forwarded).toHaveLength(2);
  for (const [request] of forwarded)
    expect(request.alexandriaVerified).toBe(true);
});

it.each([
  ["losing", { alexandriaVerified: true }, {}],
  ["gaining", {}, { alexandriaVerified: true }],
])(
  "refuses the same x-request-id after %s Alexandria Verified, rather than replaying",
  async (_case, before, after) => {
    await run({ flags: before });
    const other = await run({ flags: after });
    expect(other.status).toBe(409);
    expect(other.body).toEqual(
      expect.objectContaining({ code: "duplicate_request" }),
    );
    expect(executions()).toHaveLength(1);
  },
);

describe("work contact details only", () => {
  const forwarded = () =>
    mocks.request.mock.calls.filter(
      ([r]) => r.path.endsWith("/quote") || r.path === "/v1/retrieve",
    );
  const storedFingerprint = () => records()[0].fingerprint;

  it("forwards the option to quote and execution", async () => {
    await run({ workContactOnly: true });
    expect(forwarded()).toHaveLength(2);
    for (const [request] of forwarded())
      expect(request.workContactOnly).toBe(true);
  });

  it("forwards the option on a catalogue read", async () => {
    const read = {
      provider: "firecrawl",
      capability: "find-tools",
      options: {},
    };
    exchangeAnswers({
      success: true,
      creditsCost: 0,
      results: [{ ...read, creditsCost: 0, data: {} }],
    });
    await run({ calls: [read], workContactOnly: true });
    expect(executions()).toHaveLength(1);
    expect(executions()[0][0].workContactOnly).toBe(true);
  });

  it("sends nothing and keeps the request fingerprint as before when not asked", async () => {
    await run();
    expect(forwarded()).toHaveLength(2);
    for (const [request] of forwarded())
      expect(request).not.toHaveProperty("workContactOnly");
    const before = createHash("sha256")
      .update(
        JSON.stringify([
          [
            {
              capability: call.capability,
              options: call.options,
              provider: call.provider,
            },
          ],
          true,
        ]),
      )
      .digest("hex");
    expect(storedFingerprint()).toBe(before);
  });

  it("fingerprints a request that asks for it differently", async () => {
    await run();
    const without = storedFingerprint();
    mocks.store.clear();
    await run({ workContactOnly: true });
    expect(storedFingerprint()).not.toBe(without);
  });

  it.each([
    ["losing", { workContactOnly: true }, {}],
    ["gaining", {}, { workContactOnly: true }],
  ])(
    "refuses the same x-request-id after %s the option, rather than replaying",
    async (_case, before, after) => {
      await run(before);
      const other = await run(after);
      expect(other.status).toBe(409);
      expect(other.body).toEqual(
        expect.objectContaining({ code: "duplicate_request" }),
      );
      expect(executions()).toHaveLength(1);
    },
  );
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
  expect(mocks.recordCredits).not.toHaveBeenCalled();
});

it("records an agent call's charge when the ledger enqueue fails, since the charge stands", async () => {
  mocks.billAdd.mockRejectedValue(new Error("queue down"));
  await run({ agentRequestId: "agent-run" });
  expect(mocks.recordCredits).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ requestId: "agent-run", credits: 3 }),
  );
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

const free = (results: unknown[]) =>
  exchangeAnswers({ success: true, creditsCost: 0, results }, 200, {
    status: 200,
    body: { maximumCredits: 0 },
  });

it("tells Exchange on execution whether feedback may be stored and who is calling", async () => {
  await run({ clientOrigin: "mcp-cursor", clientIntegration: "n8n" });
  expect(executions()).toHaveLength(1);
  expect(executions()[0][0]).toMatchObject({
    feedbackStorage: "allowed",
    clientOrigin: "mcp-cursor",
    clientIntegration: "n8n",
  });
  for (const [arg] of mocks.request.mock.calls.filter(
    ([arg]) => arg.path !== "/v1/retrieve",
  )) {
    expect(arg).not.toHaveProperty("feedbackStorage");
    expect(arg).not.toHaveProperty("clientOrigin");
    expect(arg).not.toHaveProperty("clientIntegration");
  }
});

it("says the same on the catalogue read, and names no origin or integration it was not given", async () => {
  const read = { provider: "firecrawl", capability: "find-tools", options: {} };
  free([{ ...read, creditsCost: 0, data: {} }]);
  await run({ calls: [read] });
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(executions()[0][0].feedbackStorage).toBe("allowed");
  expect(executions()[0][0]).not.toHaveProperty("clientOrigin");
  expect(executions()[0][0]).not.toHaveProperty("clientIntegration");
});

it.each([
  ["opted_out", "team", { searchFeedbackOptOut: true }, true],
  ["zero_data_retention", "team", { searchZDR: "forced-anon" }, true],
  ["preview_team", "preview_example", {}, true],
  ["unavailable", "team", {}, false],
])(
  "reports feedback storage as %s",
  async (storage, teamId, flags, dbAuthentication) => {
    mocks.config.USE_DB_AUTHENTICATION = dbAuthentication;
    free([{ ...call, creditsCost: 0, data: {} }]);
    expect(await run({ teamId, flags })).toMatchObject({ executed: true });
    expect(executions()[0][0].feedbackStorage).toBe(storage);
  },
);

it("keeps who is calling out of the request fingerprint", async () => {
  expect((await run({ clientOrigin: "cli" })).executed).toBe(true);
  expect(await run({ clientOrigin: "mcp-cursor" })).toMatchObject({
    status: 200,
    executed: false,
  });
  expect(executions()).toHaveLength(1);
});

it.each(["find-tools", "library"])(
  "marks a %s read as a catalogue read and passes on the caller's session and conversation",
  async capability => {
    const read = { provider: "firecrawl", capability, options: {} };
    free([{ ...read, creditsCost: 0, data: {} }]);
    await run({
      calls: [read],
      clientSession: "sess_01A",
      clientThread: "thread:42.a-b",
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(executions()[0][0]).toMatchObject({
      searchRoute: "catalogue",
      clientSession: "sess_01A",
      clientThread: "thread:42.a-b",
    });
  },
);

it("names no session or conversation on a catalogue read that carried none", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  free([{ ...read, creditsCost: 0, data: {} }]);
  await run({ calls: [read] });
  expect(executions()[0][0].searchRoute).toBe("catalogue");
  expect(executions()[0][0]).not.toHaveProperty("clientSession");
  expect(executions()[0][0]).not.toHaveProperty("clientThread");
});

it("passes the session and conversation on a provider execution, with no route, and never on the quote", async () => {
  await run({ clientSession: "sess_01A", clientThread: "thread:42.a-b" });
  expect(executions()).toHaveLength(1);
  expect(executions()[0][0]).toMatchObject({
    clientSession: "sess_01A",
    clientThread: "thread:42.a-b",
  });
  expect(executions()[0][0]).not.toHaveProperty("searchRoute");
  for (const [arg] of mocks.request.mock.calls.filter(
    ([arg]) => arg.path !== "/v1/retrieve",
  )) {
    expect(arg).not.toHaveProperty("clientSession");
    expect(arg).not.toHaveProperty("clientThread");
    expect(arg).not.toHaveProperty("searchRoute");
  }
});

it("keeps the catalogue route when Exchange prices the read and the full path runs it", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  const priced = {
    success: true,
    creditsCost: 2,
    results: [{ ...read, creditsCost: 2, data: {} }],
  };
  mocks.request.mockImplementation(async arg =>
    arg.path.endsWith("/quote")
      ? { status: 200, body: { maximumCredits: 2 } }
      : arg.maximumCredits === 0
        ? { status: 402, body: { code: "credit_budget_exceeded" } }
        : { status: 200, body: priced },
  );
  expect(await run({ calls: [read] })).toMatchObject({ executed: true });
  expect(executions().map(([arg]) => arg.maximumCredits)).toEqual([0, 2]);
  for (const [arg] of executions()) expect(arg.searchRoute).toBe("catalogue");
});

it("names no route for a catalogue read sent beside a provider call", async () => {
  const read = { provider: "firecrawl", capability: "library", options: {} };
  exchangeAnswers({
    success: true,
    creditsCost: 3,
    results: [
      { ...call, creditsCost: 3, data: {} },
      { ...read, creditsCost: 0, data: {} },
    ],
  });
  expect(await run({ calls: [call, read] })).toMatchObject({ executed: true });
  expect(executions()).toHaveLength(1);
  expect(executions()[0][0]).not.toHaveProperty("searchRoute");
});

it("keeps the session and conversation out of the request fingerprint", async () => {
  expect((await run({ clientThread: "thread:42.a-b" })).executed).toBe(true);
  expect(await run({ clientThread: "thread:43" })).toMatchObject({
    status: 200,
    executed: false,
  });
  expect(executions()).toHaveLength(1);
});

it("runs a free Firecrawl capability without a hold or a charge and returns its answer whole", async () => {
  const report = {
    provider: "firecrawl",
    capability: "report-missing-data",
    options: { need: "<what was needed>", tried: "<what was tried>" },
  };
  const results = [
    {
      provider: report.provider,
      capability: report.capability,
      creditsCost: 0,
      data: {
        logged: true,
        reference: "ref-1",
        status: "new",
        reports: 1,
        teams: 1,
        repeat: false,
        knownProviders: [],
        message: "<message>",
      },
    },
  ];
  free(results);
  expect(await run({ calls: [report] })).toEqual({
    status: 200,
    body: { success: true, creditsCost: 0, results },
    executed: true,
    scrapeId: "scrape-1",
  });
  expect(executions()[0][0]).toMatchObject({
    body: { requests: [report] },
    maximumCredits: 0,
    feedbackStorage: "allowed",
  });
  expect(mocks.lock).not.toHaveBeenCalled();
  expect(mocks.finalize).not.toHaveBeenCalled();
  expect(mocks.billAdd).not.toHaveBeenCalled();
  expect(mocks.recordCredits).not.toHaveBeenCalled();
});
