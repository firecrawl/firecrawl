import express from "express";
import request from "supertest";

vi.mock("../../lib/billing-country", () => ({
  billingCountryForTeam: vi.fn(async () => undefined),
}));
const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  log: vi.fn(),
  scrapeLog: vi.fn(),
  discovery: vi.fn(),
  recordDiscovered: vi.fn(),
}));
vi.mock("../../lib/alexandria-discovery", () => ({
  discoveryForCalls: mocks.discovery,
  recordDiscoveredTools: mocks.recordDiscovered,
}));
vi.mock("../../services/alexandria/retrieve", () => ({
  REQUEST_ID_PATTERN: /^[A-Za-z0-9._:-]{1,128}$/,
  retrieveProviders: mocks.retrieve,
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.log,
  logProviderScrape: mocks.scrapeLog,
}));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: async () => ({ allowed: true }),
}));
vi.mock("../../lib/agent-interop", () => ({
  isAgentInteropSecretValid: (value: string) => value === "test-secret",
}));
// orgIdFromAcuc answers null without it, so the ACUC's org needs it on.
vi.mock("../../config", () => ({
  config: {
    FIRE_EXCHANGE_URL: "https://x",
    AGENT_INTEROP_SECRET: "test-secret",
    USE_DB_AUTHENTICATION: true,
  },
}));
import { providerScrapeController } from "./scrape-alexandria";

const call = {
  provider: "fred",
  capability: "categories/category",
  options: {},
};
let flags: Record<string, unknown> = { exchangeRetrieve: true };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: "team" },
    acuc: {
      api_key_id: 12,
      org_id: "org",
      flags,
    },
  });
  next();
});
app.post("/v2/scrape", (req, res) => providerScrapeController(req as any, res));
app.post("/exchange/retrieve", (req, res) =>
  providerScrapeController(req as any, res, true),
);
const result = (results: unknown[], executed = true) => ({
  status: 200,
  body: { success: true, creditsCost: 0, results },
  executed,
  scrapeId: "scrape-1",
});

beforeEach(() => {
  vi.clearAllMocks();
  flags = { exchangeRetrieve: true };
  mocks.log.mockResolvedValue(undefined);
  mocks.scrapeLog.mockResolvedValue(undefined);
  mocks.discovery.mockImplementation(async (_teamId, calls: unknown[]) =>
    calls.map(() => ({})),
  );
  mocks.retrieve.mockResolvedValue(
    result([{ ...call, creditsCost: 0, data: {} }]),
  );
});

it("returns the Scrape contract, shares identity with the legacy route, and logs once per execution", async () => {
  const response = await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "same-request")
    .send({ alexandria: call });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    success: true,
    scrape_id: "scrape-1",
    data: { alexandria: [expect.any(Object)], creditsCost: 0 },
  });
  expect(response.headers["x-request-id"]).toBe("same-request");
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({
      calls: [call],
      requestId: "same-request",
      apiKeyId: 12,
      orgId: "org",
    }),
  );

  mocks.retrieve.mockResolvedValue(
    result([{ ...call, creditsCost: 0, data: {} }], false),
  );
  await request(app)
    .post("/exchange/retrieve")
    .set("x-request-id", "same-request")
    .send(call);
  const [first, second] = mocks.retrieve.mock.calls.map(([arg]) => arg);
  expect({ ...first, scrapeId: undefined }).toEqual({
    ...second,
    scrapeId: undefined,
  });
  expect(mocks.scrapeLog).toHaveBeenCalledTimes(1);
  expect(mocks.scrapeLog).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "scrape-1",
      request_id: "scrape-1",
      target: "alexandria:fred/categories/category",
      credits_cost: 0,
      is_successful: true,
      time_taken: expect.any(Number),
    }),
  );
  expect(mocks.log).toHaveBeenCalledTimes(1);
  expect(mocks.log).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "alexandria", jobAccess: false }),
  );
});

it("relays a failed single legacy call as an error, not a success", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      {
        ...call,
        creditsCost: 0,
        error: { code: "credential_missing", message: "No key.", status: 503 },
      },
    ]),
  );
  const response = await request(app).post("/exchange/retrieve").send(call);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    success: false,
    code: "credential_missing",
    error: "No key.",
  });
});

it("only lets trusted agent interop bypass billing, and charges its run without keying calls by it", async () => {
  const untrusted = await request(app)
    .post("/v2/scrape")
    .send({
      alexandria: call,
      __agentInterop: { auth: "wrong", requestId: "a", shouldBill: false },
    });
  expect(untrusted.status).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();

  const trusted = await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "hop-id")
    .send({
      alexandria: call,
      __agentInterop: {
        auth: "test-secret",
        requestId: "agent-id",
        shouldBill: false,
        boostConcurrency: true,
      },
    });
  expect(trusted.status).toBe(200);
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "hop-id",
      agentRequestId: "agent-id",
      bypassBilling: true,
    }),
  );
  expect(mocks.log).not.toHaveBeenCalled();
  expect(mocks.scrapeLog).not.toHaveBeenCalled();
});

it("gives each agent call its own request id when the agent sends none", async () => {
  const interop = {
    auth: "test-secret",
    requestId: "agent-id",
    shouldBill: true,
  };
  await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call, __agentInterop: interop });
  await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call, __agentInterop: interop });
  const [first, second] = mocks.retrieve.mock.calls.map(([arg]) => arg);
  expect(first.agentRequestId).toBe("agent-id");
  expect(second.agentRequestId).toBe("agent-id");
  expect(first.requestId).not.toBe("agent-id");
  expect(first.requestId).not.toBe(second.requestId);
});

it("accepts agent interop on both legacy request shapes", async () => {
  const interop = {
    auth: "test-secret",
    requestId: "agent-id",
    shouldBill: true,
  };
  const single = await request(app)
    .post("/exchange/retrieve")
    .send({ ...call, zeroDataRetention: true, __agentInterop: interop });
  const batch = await request(app)
    .post("/exchange/retrieve")
    .send({ requests: [call], __agentInterop: interop });
  expect(single.status).toBe(200);
  expect(batch.status).toBe(200);
  for (const [arg] of mocks.retrieve.mock.calls)
    expect(arg).toEqual(
      expect.objectContaining({
        calls: [call],
        agentRequestId: "agent-id",
        bypassBilling: false,
      }),
    );
  expect(mocks.retrieve.mock.calls[0][0].zeroDataRetention).toBe(true);

  const untrusted = await request(app)
    .post("/exchange/retrieve")
    .send({ ...call, __agentInterop: { ...interop, auth: "wrong" } });
  expect(untrusted.status).toBe(403);
  expect(mocks.retrieve).toHaveBeenCalledTimes(2);
});

it("returns before logging finishes but orders the child after the parent", async () => {
  let finish!: () => void;
  mocks.log.mockReturnValue(
    new Promise<void>(resolve => {
      finish = resolve;
    }),
  );
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(200);
  expect(mocks.scrapeLog).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
});

it("logs executed non-200 responses with known credits and failure details", async () => {
  mocks.retrieve.mockResolvedValue({
    executed: true,
    scrapeId: "failed-1",
    status: 503,
    body: { error: "Provider unavailable", creditsCost: 2 },
  });
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(503);
  expect(mocks.scrapeLog).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "failed-1",
      request_id: "failed-1",
      is_successful: false,
      error: "Provider unavailable",
      credits_cost: 2,
      time_taken: expect.any(Number),
    }),
  );
});

it("does not log activity when retrieval rejects", async () => {
  mocks.retrieve.mockRejectedValue(new Error("Unavailable"));
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({
    success: false,
    error: "Provider request unavailable. Retry with the same x-request-id.",
  });
  expect(mocks.log).not.toHaveBeenCalled();
  expect(mocks.scrapeLog).not.toHaveBeenCalled();
});

it("logs per-tool errors even when the response is HTTP 200", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      {
        ...call,
        creditsCost: 0,
        error: {
          code: "provider_unavailable",
          message: "Provider unavailable",
          status: 503,
        },
      },
    ]),
  );
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(200);
  expect(mocks.scrapeLog).toHaveBeenCalledWith(
    expect.objectContaining({
      is_successful: false,
      error: "Provider unavailable",
      credits_cost: 0,
    }),
  );
});

it("uses a failure fallback when no error message is available", async () => {
  mocks.retrieve.mockResolvedValue({
    executed: true,
    scrapeId: "failed-1",
    status: 503,
    body: {},
  });
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(503);
  expect(mocks.scrapeLog).toHaveBeenCalledWith(
    expect.objectContaining({
      is_successful: false,
      error: "Provider request failed (503).",
      credits_cost: 0,
    }),
  );
});

it("executes with supplied arguments but stores only tool identifiers in activity options", async () => {
  const supplied = {
    ...call,
    options: {
      query: "private customer data",
      token: "secret-token",
      nested: { authorization: "Bearer secret" },
    },
  };
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: supplied });
  expect(response.status).toBe(200);
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({ calls: [supplied] }),
  );
  expect(mocks.scrapeLog).toHaveBeenCalledTimes(1);
  expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
    alexandria: [
      {
        provider: call.provider,
        capability: call.capability,
        code: null,
        creditsCost: 0,
      },
    ],
  });
});

it("logs each call's own outcome code and credits in request order", async () => {
  const other = { provider: "sec", capability: "filings/search", options: {} };
  const answer = result([
    { ...call, creditsCost: 3, data: {} },
    { error: { code: "not_found", message: "No such filing.", status: 404 } },
    {
      ...call,
      creditsCost: 0,
      error: { code: "rate_limited", message: "Slow down.", status: 429 },
    },
  ]);
  mocks.retrieve.mockResolvedValue({
    ...answer,
    body: { ...answer.body, creditsCost: 3 },
  });
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: [call, other, call] });
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  const logged = mocks.scrapeLog.mock.calls[0][0];
  expect(logged.options).toEqual({
    alexandria: [
      {
        provider: call.provider,
        capability: call.capability,
        code: null,
        creditsCost: 3,
      },
      {
        provider: other.provider,
        capability: other.capability,
        code: "not_found",
        creditsCost: 0,
      },
      {
        provider: call.provider,
        capability: call.capability,
        code: "rate_limited",
        creditsCost: 0,
      },
    ],
  });
  expect(logged).toEqual(
    expect.objectContaining({
      is_successful: false,
      error: "No such filing.",
      credits_cost: 3,
    }),
  );
});

it("keeps identifier-only options when the answer does not parse", async () => {
  mocks.retrieve.mockResolvedValue({
    executed: true,
    scrapeId: "failed-1",
    status: 402,
    body: { success: false, error: "Insufficient credits." },
  });
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(402);
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
    alexandria: [{ provider: call.provider, capability: call.capability }],
  });
});

it("forwards zero data retention for forced-ZDR teams instead of refusing them", async () => {
  flags = { exchangeRetrieve: true, forceZDR: true };
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(200);
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({ zeroDataRetention: true }),
  );
  await vi.waitFor(() =>
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    ),
  );
});

it("accepts zero data retention in the body and forwards it", async () => {
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call, zeroDataRetention: true });
  expect(response.status).toBe(200);
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({ zeroDataRetention: true }),
  );
  await vi.waitFor(() =>
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    ),
  );
});

it("accepts zero data retention on both legacy request shapes", async () => {
  const single = await request(app)
    .post("/exchange/retrieve")
    .send({ ...call, zeroDataRetention: true });
  expect(single.status).toBe(200);
  const batch = await request(app)
    .post("/exchange/retrieve")
    .send({ requests: [call], zeroDataRetention: true });
  expect(batch.status).toBe(200);
  for (const [arg] of mocks.retrieve.mock.calls)
    expect(arg).toMatchObject({ calls: [call], zeroDataRetention: true });
});

it("tells the provider activity log about zero data retention", async () => {
  await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call, zeroDataRetention: true });
  await vi.waitFor(() =>
    expect(mocks.scrapeLog).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: true }),
    ),
  );
});

it("does not ask for zero data retention by default", async () => {
  await request(app).post("/v2/scrape").send({ alexandria: call });
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({ zeroDataRetention: false }),
  );
  await vi.waitFor(() =>
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ zeroDataRetention: false }),
    ),
  );
});

const findTools = {
  provider: "firecrawl",
  capability: "find-tools",
  options: {
    query: "podcast sponsors",
    providers: ["particle"],
    urls: ["https://a.example/", "https://b.example/"],
    token: "secret-token",
  },
};

it("logs find-tools options and result size, and remembers the tools it showed", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      {
        provider: "firecrawl",
        capability: "find-tools",
        creditsCost: 0,
        data: {
          level: "tools",
          items: [
            { provider: "particle", capability: "advertising/sponsors" },
            { provider: "particle", capability: "podcasts/show" },
            { provider: "particle", id: "particle" },
          ],
        },
      },
    ]),
  );
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: findTools });
  expect(response.status).toBe(200);
  expect(mocks.recordDiscovered).toHaveBeenCalledWith(
    "team",
    "find_tools",
    "scrape-1",
    [
      { provider: "particle", capability: "advertising/sponsors" },
      { provider: "particle", capability: "podcasts/show" },
    ],
  );
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
    alexandria: [
      {
        provider: "firecrawl",
        capability: "find-tools",
        code: null,
        creditsCost: 0,
        options: {
          query: "podcast sponsors",
          providers: ["particle"],
          urlCount: 2,
        },
        returned: 3,
      },
    ],
  });
});

it("attributes each provider call to the discovery that showed it", async () => {
  mocks.discovery.mockResolvedValue([
    {
      search: { id: "search-1", secondsBefore: 40 },
      find_tools: { id: "scrape-0", secondsBefore: 12 },
    },
  ]);
  await request(app).post("/v2/scrape").send({ alexandria: call });
  expect(mocks.discovery).toHaveBeenCalledWith("team", [call]);
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
    alexandria: [
      {
        provider: call.provider,
        capability: call.capability,
        code: null,
        creditsCost: 0,
        discovery: {
          search: { id: "search-1", secondsBefore: 40 },
          find_tools: { id: "scrape-0", secondsBefore: 12 },
        },
      },
    ],
  });
});

it("still logs the call when the discovery lookup fails", async () => {
  mocks.discovery.mockRejectedValue(new Error("Redis unavailable"));
  await request(app).post("/v2/scrape").send({ alexandria: call });
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
    alexandria: [
      {
        provider: call.provider,
        capability: call.capability,
        code: null,
        creditsCost: 0,
      },
    ],
  });
});

it("neither reads nor records discovery under zero data retention", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      {
        provider: "firecrawl",
        capability: "find-tools",
        creditsCost: 0,
        data: { items: [{ provider: "fred", capability: "series/search" }] },
      },
    ]),
  );
  await request(app)
    .post("/v2/scrape")
    .send({ alexandria: findTools, zeroDataRetention: true });
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.discovery).not.toHaveBeenCalled();
  expect(mocks.recordDiscovered).not.toHaveBeenCalled();
});
