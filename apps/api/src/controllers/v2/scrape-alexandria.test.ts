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
  libraryTools: vi.fn(),
  markCalls: vi.fn(),
  providerToolsBody: vi.fn(),
  optionTypes: vi.fn(),
}));
vi.mock("../../services/alexandria/option-types", () => ({
  capabilityOptionTypes: mocks.optionTypes,
}));
vi.mock("../../lib/alexandria-activity", () => ({
  markAlexandriaActivity: vi.fn(),
  markAlexandriaCalls: mocks.markCalls,
}));
vi.mock("../../lib/alexandria-discovery", () => ({
  discoveryForCalls: mocks.discovery,
  libraryCommandTools: mocks.libraryTools,
  recordDiscoveredTools: mocks.recordDiscovered,
}));
vi.mock("../../services/alexandria/retrieve", () => ({
  REQUEST_ID_PATTERN: /^[A-Za-z0-9._:-]{1,128}$/,
  exchangeRequestId: (teamId: string, requestId: string) =>
    `hashed:${teamId}:${requestId}`,
  retrieveProviders: mocks.retrieve,
}));
vi.mock("../../services/logging/log_job", () => ({
  logRequest: mocks.log,
  logProviderScrape: mocks.scrapeLog,
}));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: async () => ({ allowed: true }),
}));
vi.mock("../../lib/keyless", () => ({
  keylessProviderToolsBody: mocks.providerToolsBody,
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
    AGENT_AUTH_RESOURCE_METADATA_URL: "https://x/auth",
  },
}));
vi.mock("../../lib/feedback-env", () => ({
  feedbackEnv: {
    ALEXANDRIA_FEEDBACK_HINT_ENABLED: false,
    FEEDBACK_REFUND_ENABLED: false,
  },
}));
import {
  alexandriaQueryBody,
  providerScrapeController,
} from "./scrape-alexandria";
import { resolveIntegration } from "../../utils/integration";
import { config } from "../../config";
import { feedbackEnv } from "../../lib/feedback-env";
import { verifyFeedbackToken } from "../../lib/alexandria-feedback-token";
import { alexandriaFeedbackNextStep } from "../../lib/alexandria-feedback-hint";

const call = {
  provider: "fred",
  capability: "categories/category",
  options: {},
};
let flags: Record<string, unknown> = { exchangeRetrieve: true };
let teamId = "team";
let hostedMcp = false;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: teamId, ...(hostedMcp ? { hostedMcp } : {}) },
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
// Stands in for inferIntegrationMiddleware, which the routes run after these steps; importing the
// routes would load the whole API.
const integration = (req: any, _res: any, next: () => void) => {
  const resolved = resolveIntegration(req.body?.integration, req);
  if (resolved !== undefined) req.body.integration = resolved;
  next();
};
app.post("/v2/alexandria", integration, (req, res) =>
  providerScrapeController(req as any, res, true),
);
app.get(
  "/v2/alexandria/:provider/*capability",
  (req, res, next) => {
    alexandriaQueryBody(req, res, next).catch(next);
  },
  integration,
  (req, res) => providerScrapeController(req as any, res, true),
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
  teamId = "team";
  hostedMcp = false;
  mocks.log.mockResolvedValue(undefined);
  mocks.scrapeLog.mockResolvedValue(undefined);
  mocks.optionTypes.mockResolvedValue(new Map());
  mocks.discovery.mockImplementation(async (_teamId, calls: unknown[]) =>
    calls.map(() => ({ discovery: {} })),
  );
  mocks.libraryTools.mockReturnValue([]);
  mocks.retrieve.mockResolvedValue(
    result([{ ...call, creditsCost: 0, data: {} }]),
  );
});

it("refuses a keyless caller with its signup link and the auth discovery header", async () => {
  teamId = "preview_keyless_203.0.113.8";
  const refusal = {
    success: false,
    error: "An API key is required for provider tools.",
    signup_url: "https://firecrawl.dev/k/token",
  };
  mocks.providerToolsBody.mockReturnValue(refusal);
  const response = await request(app)
    .post("/v2/scrape")
    .set("x-origin", "cli")
    .send({ alexandria: call });
  expect(response.status).toBe(403);
  expect(response.body).toEqual(refusal);
  expect(mocks.providerToolsBody).toHaveBeenCalledExactlyOnceWith(
    teamId,
    expect.objectContaining({
      body: { alexandria: call },
      headers: expect.objectContaining({ "x-origin": "cli" }),
    }),
  );
  expect(response.headers["www-authenticate"]).toBe(
    'Bearer resource_metadata="https://x/auth"',
  );
  expect(mocks.retrieve).not.toHaveBeenCalled();
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

it("logs each call's provenance and keeps it out of the response", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      { ...call, provenance: "workflows_programs", creditsCost: 0, data: {} },
    ]),
  );
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: [call] });
  expect(response.status).toBe(200);
  expect(response.body.data.alexandria[0]).not.toHaveProperty("provenance");
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  expect(mocks.scrapeLog.mock.calls[0][0].options.alexandria[0]).toEqual(
    expect.objectContaining({ provenance: "workflows_programs" }),
  );
  const legacy = await request(app).post("/exchange/retrieve").send(call);
  expect(legacy.status).toBe(200);
  expect(legacy.body).not.toHaveProperty("provenance");
});

it("drops an unknown or null provenance instead of failing the call", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      { ...call, provenance: "elsewhere", creditsCost: 0, data: {} },
      { ...call, provenance: null, creditsCost: 0, data: {} },
    ]),
  );
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: [call, call] });
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
  for (const logged of mocks.scrapeLog.mock.calls[0][0].options.alexandria)
    expect(logged).not.toHaveProperty("provenance");
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

it("keeps every call under zero data retention for teams with Alexandria ZDR forced", async () => {
  flags = {
    exchangeRetrieve: true,
    alexandriaZDR: "forced",
    scrapeZDR: "allowed",
  };
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
  await vi.waitFor(() =>
    expect(mocks.scrapeLog).toHaveBeenCalledWith(
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

it("logs the integration on the flat route from the body or the X-Integration header", async () => {
  await request(app)
    .post("/v2/alexandria")
    .send({ ...call, integration: "n8n" });
  await request(app)
    .post("/v2/alexandria")
    .set("x-integration", "zapier")
    .send(call);
  expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => {
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "n8n" }),
    );
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "zapier" }),
    );
  });
});

it("accepts a timeout on both legacy request shapes", async () => {
  await request(app)
    .post("/exchange/retrieve")
    .send({ ...call, timeout: 30_000 });
  await request(app)
    .post("/exchange/retrieve")
    .send({ requests: [call], timeout: 30_000 });
  expect(mocks.retrieve).toHaveBeenCalledTimes(2);
  for (const [arg] of mocks.retrieve.mock.calls)
    expect(arg).toMatchObject({ calls: [call], timeoutMs: 30_000 });
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
      { provider: "particle", capability: "advertising/sponsors", rank: 1 },
      { provider: "particle", capability: "podcasts/show", rank: 2 },
    ],
    { requestId: expect.stringMatching(/^hashed:team:/) },
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
      discovery: {
        search: { id: "search-1", secondsBefore: 40 },
        find_tools: { id: "scrape-0", secondsBefore: 12 },
      },
    },
  ]);
  await request(app).post("/v2/scrape").send({ alexandria: call });
  expect(mocks.discovery).toHaveBeenCalledWith("team", [call], {});
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

it.each([
  {
    discovery: { search: { id: "search-1", secondsBefore: 40 } },
    search: {
      id: "search-1",
      source: "search",
      rank: 2,
      match: "conversation",
      secondsBefore: 40,
    },
  },
  {
    discovery: { find_tools: { id: "scrape-0", secondsBefore: 12 } },
    search: {
      id: "scrape-0",
      source: "find_tools",
      rank: 1,
      match: "session",
      secondsBefore: 12,
      requestId: "hashed:team:find-1",
    },
  },
  {
    discovery: {},
    search: {
      id: "scrape-9",
      source: "library",
      rank: 3,
      match: "team",
      secondsBefore: 300,
      requestId: "hashed:team:library-1",
    },
  },
])(
  "logs the search that led to a provider call beside its discovery ($search.match)",
  async found => {
    mocks.discovery.mockResolvedValue([found]);
    await request(app).post("/v2/scrape").send({ alexandria: call });
    await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
    expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
      alexandria: [
        {
          provider: call.provider,
          capability: call.capability,
          code: null,
          creditsCost: 0,
          ...(Object.keys(found.discovery).length
            ? { discovery: found.discovery }
            : {}),
          search: found.search,
        },
      ],
    });
  },
);

it("logs the call without waiting on a discovery lookup that hangs", async () => {
  mocks.discovery.mockReturnValue(new Promise(() => {}));
  const response = await request(app)
    .post("/v2/scrape")
    .send({ alexandria: call });
  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1), {
    timeout: 3000,
  });
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

it("ranks find-tools answers from the offset the call asked for", async () => {
  mocks.retrieve.mockResolvedValue(
    result([
      {
        provider: "firecrawl",
        capability: "find-tools",
        creditsCost: 0,
        data: {
          items: [
            { provider: "fred", capability: "series/search" },
            { provider: "fred", id: "fred" },
            { provider: "fred", capability: "series/observations" },
          ],
        },
      },
    ]),
  );
  await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "find-1")
    .send({
      alexandria: {
        provider: "firecrawl",
        capability: "find-tools",
        options: { query: "weather in Lisbon", offset: 10 },
      },
    });
  expect(mocks.recordDiscovered).toHaveBeenCalledWith(
    "team",
    "find_tools",
    "scrape-1",
    [
      { provider: "fred", capability: "series/search", rank: 11 },
      { provider: "fred", capability: "series/observations", rank: 13 },
    ],
    { requestId: "hashed:team:find-1" },
  );
});

describe("a library command", () => {
  const library = {
    provider: "firecrawl",
    capability: "library",
    options: { command: "grep -rl forecast /library/weather" },
  };
  const stdout = "/library/weather/open-meteo/forecast/daily.md\n";
  const listed = [
    { provider: "open-meteo", capability: "forecast/daily", rank: 1 },
  ];

  beforeEach(() => {
    mocks.libraryTools.mockReturnValue(listed);
    mocks.retrieve.mockResolvedValue(
      result([
        {
          provider: "firecrawl",
          capability: "library",
          creditsCost: 0,
          data: { stdout, stderr: "", exitCode: 0 },
        },
      ]),
    );
  });

  it("remembers the tools it listed, with their ranks, and logs only its identifiers", async () => {
    const response = await request(app)
      .post("/v2/scrape")
      .set("x-request-id", "library-1")
      .send({ alexandria: library });
    expect(response.status).toBe(200);
    expect(mocks.libraryTools).toHaveBeenCalledExactlyOnceWith(
      library.options.command,
      stdout,
    );
    expect(mocks.recordDiscovered).toHaveBeenCalledWith(
      "team",
      "library",
      "scrape-1",
      listed,
      { requestId: "hashed:team:library-1" },
    );
    await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
    expect(mocks.scrapeLog.mock.calls[0][0].options).toEqual({
      alexandria: [
        {
          provider: "firecrawl",
          capability: "library",
          code: null,
          creditsCost: 0,
        },
      ],
    });
  });

  it("records and attributes nothing under zero data retention", async () => {
    await request(app)
      .post("/v2/scrape")
      .send({ alexandria: library, zeroDataRetention: true });
    await vi.waitFor(() => expect(mocks.scrapeLog).toHaveBeenCalledTimes(1));
    expect(mocks.libraryTools).not.toHaveBeenCalled();
    expect(mocks.recordDiscovered).not.toHaveBeenCalled();
    expect(mocks.discovery).not.toHaveBeenCalled();
    expect(
      mocks.scrapeLog.mock.calls[0][0].options.alexandria[0],
    ).not.toHaveProperty("search");
  });
});

describe("a hosted MCP caller's session and conversation", () => {
  const header = Buffer.from(
    JSON.stringify({
      session_id: "sess_01A",
      session_source: "token",
      thread_id: "thread:42.a-b",
      thread_source: "client",
    }),
  ).toString("base64url");

  it("reach the catalogue read, the discovery lookup and what the read records", async () => {
    hostedMcp = true;
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
      .post("/v2/alexandria")
      .set("x-firecrawl-mcp-lineage", header)
      .set("x-request-id", "find-1")
      .send(findTools);
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        calls: [findTools],
        clientSession: "sess_01A",
        clientThread: "thread:42.a-b",
      }),
    );
    const lineage = { sessionId: "sess_01A", threadId: "thread:42.a-b" };
    expect(mocks.discovery).toHaveBeenCalledWith("team", [findTools], lineage);
    expect(mocks.recordDiscovered).toHaveBeenCalledWith(
      "team",
      "find_tools",
      "scrape-1",
      [{ provider: "fred", capability: "series/search", rank: 1 }],
      { ...lineage, requestId: "hashed:team:find-1" },
    );
  });

  it.each([
    ["a request without the header", true, undefined],
    ["a caller that is not the hosted MCP", false, header],
    ["a header that does not decode", true, "not-json"],
  ])("are not read from %s", async (_name, hosted, sent) => {
    hostedMcp = hosted;
    const post = request(app).post("/v2/scrape");
    if (sent) post.set("x-firecrawl-mcp-lineage", sent);
    await post.send({ alexandria: call });
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    const sentToRetrieve = mocks.retrieve.mock.calls[0][0];
    expect(sentToRetrieve).not.toHaveProperty("clientSession");
    expect(sentToRetrieve).not.toHaveProperty("clientThread");
    expect(mocks.discovery).toHaveBeenCalledWith("team", [call], {});
  });
});

it("remembers each provider call under its request id for feedback attribution", async () => {
  const second = { provider: "sec", capability: "filings", options: {} };
  await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "req-1")
    .send({ alexandria: [call, second] });
  expect(mocks.markCalls).toHaveBeenCalledExactlyOnceWith("team", [
    {
      requestId: "hashed:team:req-1",
      provider: "fred",
      capability: "categories/category",
    },
    { requestId: "hashed:team:req-1", provider: "sec", capability: "filings" },
  ]);
});

it("does not remember calls the Exchange did not execute", async () => {
  mocks.retrieve.mockResolvedValue(
    result([{ ...call, creditsCost: 0, data: {} }], false),
  );
  await request(app).post("/v2/scrape").send({ alexandria: call });
  expect(mocks.markCalls).not.toHaveBeenCalled();
});

it.each([
  [{ alexandria: call, zeroDataRetention: true }, {}],
  [{ alexandria: call }, { forceZDR: true }],
])(
  "does not remember provider calls under zero data retention %#",
  async (body, teamFlags) => {
    flags = { exchangeRetrieve: true, ...teamFlags };
    await request(app).post("/v2/scrape").send(body);
    expect(mocks.markCalls).not.toHaveBeenCalled();
  },
);

describe("feedback tokens", () => {
  afterEach(() => {
    (config as { EXCHANGE_INTERNAL_SECRET?: string }).EXCHANGE_INTERNAL_SECRET =
      undefined;
  });
  beforeEach(() => {
    (config as { EXCHANGE_INTERNAL_SECRET?: string }).EXCHANGE_INTERNAL_SECRET =
      "internal-secret";
  });

  it("returns a team-bound token per provider call, failed calls included", async () => {
    const second = { provider: "sec", capability: "filings", options: {} };
    mocks.retrieve.mockResolvedValue(
      result([
        { ...call, creditsCost: 0, data: {} },
        { error: { code: "provider_error", message: "down" } },
      ]),
    );
    const response = await request(app)
      .post("/v2/scrape")
      .set("x-request-id", "req-1")
      .send({ alexandria: [call, second] });
    const [first, failed] = response.body.data.alexandria;
    expect(verifyFeedbackToken(first.feedbackToken, "team")).toMatchObject({
      requestId: "hashed:team:req-1",
      provider: "fred",
      capability: "categories/category",
    });
    expect(verifyFeedbackToken(failed.feedbackToken, "team")).toMatchObject({
      requestId: "hashed:team:req-1",
      provider: "sec",
      capability: "filings",
    });
    expect(verifyFeedbackToken(first.feedbackToken, "other-team")).toBeNull();
  });

  it("returns the token on the legacy single-call route, errors included", async () => {
    const response = await request(app).post("/exchange/retrieve").send(call);
    expect(response.body.feedbackToken).toEqual(expect.any(String));
    mocks.retrieve.mockResolvedValue(
      result([
        { error: { code: "provider_error", message: "down", status: 502 } },
      ]),
    );
    const failed = await request(app).post("/exchange/retrieve").send(call);
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({
      success: false,
      code: "provider_error",
      error: "down",
      feedbackToken: expect.any(String),
    });
    expect(
      verifyFeedbackToken(failed.body.feedbackToken, "team"),
    ).toMatchObject({ provider: "fred", capability: "categories/category" });
  });

  it.each([
    [{ alexandria: call, zeroDataRetention: true }, {}],
    [{ alexandria: call }, { forceZDR: true }],
  ])(
    "issues no token under zero data retention %#",
    async (body, teamFlags) => {
      flags = { exchangeRetrieve: true, ...teamFlags };
      const response = await request(app).post("/v2/scrape").send(body);
      expect(response.status).toBe(200);
      expect(response.body.data.alexandria[0].feedbackToken).toBeUndefined();
    },
  );

  it("issues no token without a signing key", async () => {
    (config as { EXCHANGE_INTERNAL_SECRET?: string }).EXCHANGE_INTERNAL_SECRET =
      undefined;
    const response = await request(app)
      .post("/v2/scrape")
      .send({ alexandria: call });
    expect(response.body.data.alexandria[0].feedbackToken).toBeUndefined();
  });
});

describe("ultrasearch trusted marker", () => {
  const proxyConfig = config as {
    HOSTED_MCP_PROXY_SECRET?: string;
    KEYLESS_PROXY_SECRET?: string;
  };

  afterEach(() => {
    proxyConfig.HOSTED_MCP_PROXY_SECRET = undefined;
    proxyConfig.KEYLESS_PROXY_SECRET = undefined;
  });

  it("honours x-firecrawl-ultrasearch with x-firecrawl-hosted-mcp-secret alone", async () => {
    proxyConfig.HOSTED_MCP_PROXY_SECRET = "dedicated-hosted-mcp-secret";
    const response = await request(app)
      .post("/v2/scrape")
      .set("authorization", "Bearer fc-api-key")
      .set("x-firecrawl-ultrasearch", "true")
      .set("x-firecrawl-hosted-mcp-secret", "dedicated-hosted-mcp-secret")
      .send({ alexandria: call });
    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ ultrasearch: true }),
    );
  });

  it("ignores x-firecrawl-ultrasearch on wrong secret or fco_ token", async () => {
    proxyConfig.HOSTED_MCP_PROXY_SECRET = "dedicated-hosted-mcp-secret";
    await request(app)
      .post("/v2/scrape")
      .set("authorization", "Bearer fc-api-key")
      .set("x-firecrawl-ultrasearch", "true")
      .set("x-firecrawl-hosted-mcp-secret", "wrong")
      .send({ alexandria: call });
    expect(mocks.retrieve).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ ultrasearch: true }),
    );

    await request(app)
      .post("/v2/scrape")
      .set("authorization", "Bearer fco_oauth_token")
      .set("x-firecrawl-ultrasearch", "true")
      .set("x-firecrawl-hosted-mcp-secret", "dedicated-hosted-mcp-secret")
      .send({ alexandria: call });
    expect(mocks.retrieve).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ ultrasearch: true }),
    );
  });

  it("still honours x-firecrawl-keyless-secret as rollout fallback", async () => {
    proxyConfig.KEYLESS_PROXY_SECRET = "legacy-keyless-secret";
    const response = await request(app)
      .post("/v2/scrape")
      .set("authorization", "Bearer fc-api-key")
      .set("x-firecrawl-ultrasearch", "true")
      .set("x-firecrawl-keyless-secret", "legacy-keyless-secret")
      .send({ alexandria: call });
    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ ultrasearch: true }),
    );
  });
});

describe("work contact details only", () => {
  it("asks for it when x-firecrawl-work-contact-only is true", async () => {
    const response = await request(app)
      .post("/v2/scrape")
      .set("x-firecrawl-work-contact-only", "true")
      .send({ alexandria: call });
    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ workContactOnly: true }),
    );
  });

  it("asks for it on an agent interop call that carries the header", async () => {
    const response = await request(app)
      .post("/v2/scrape")
      .set("x-firecrawl-work-contact-only", "true")
      .send({
        alexandria: call,
        __agentInterop: {
          auth: "test-secret",
          requestId: "agent-run",
          shouldBill: true,
        },
      });
    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ workContactOnly: true }),
    );
  });

  it.each([undefined, "false", "TRUE", "1"])(
    "leaves it off when the header is %s",
    async value => {
      let req = request(app).post("/v2/scrape");
      if (value !== undefined)
        req = req.set("x-firecrawl-work-contact-only", value);
      const response = await req.send({ alexandria: call });
      expect(response.status).toBe(200);
      expect(mocks.retrieve.mock.calls[0][0]).not.toHaveProperty(
        "workContactOnly",
      );
    },
  );
});

describe("GET /v2/alexandria/:provider/*capability", () => {
  const path = "/v2/alexandria/fred/categories/category";

  it("builds the call from the path and query, typed by the contract", async () => {
    mocks.optionTypes.mockResolvedValue(
      new Map([
        ["limit", "number"],
        ["zip", "string"],
        ["tags", "string[]"],
      ]),
    );
    const response = await request(app).get(
      `${path}?limit=10&zip=02139&tags=a&tags=b&filters.country=US&timeout=30000&version=1.2.0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.optionTypes).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fred",
        capability: "categories/category",
      }),
    );
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 30_000,
        calls: [
          {
            ...call,
            version: "1.2.0",
            options: {
              limit: 10,
              zip: "02139",
              tags: ["a", "b"],
              filters: { country: "US" },
            },
          },
        ],
      }),
    );
  });

  it("marks every /v2/alexandria answer no-store", async () => {
    for (const response of [
      await request(app).get(path),
      await request(app).post("/v2/alexandria").send(call),
    ])
      expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers exactly as POST /v2/alexandria", async () => {
    const get = await request(app).get(path);
    const post = await request(app).post("/v2/alexandria").send(call);
    expect(get.status).toBe(200);
    expect(get.body).toEqual(post.body);
  });

  it("gives declared options named timeout or with dots to the provider", async () => {
    mocks.optionTypes.mockResolvedValue(
      new Map([
        ["timeout", "number"],
        ["meta.version", "string"],
      ]),
    );
    const response = await request(app)
      .get(`${path}?timeout=5&meta.version=4`)
      .set("x-timeout-ms", "60000");
    expect(response.status).toBe(200);
    const [arg] = mocks.retrieve.mock.calls[0];
    expect(arg.calls[0].options).toEqual({ timeout: 5, "meta.version": "4" });
    expect(arg.timeoutMs).toBe(60_000);
  });

  it("refuses a timeout it cannot read instead of falling back to the default", async () => {
    for (const value of ["soon", "0", "-5", "1.5", "1e3"]) {
      const header = await request(app).get(path).set("x-timeout-ms", value);
      expect(header.status, `x-timeout-ms: ${value}`).toBe(400);
      expect(header.body.error).toMatch(/whole number of milliseconds/);
      const query = await request(app).get(
        `${path}?timeout=${encodeURIComponent(value)}`,
      );
      expect(query.status, `timeout=${value}`).toBe(400);
    }
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("refuses a timeout given in both the query and the header", async () => {
    const response = await request(app)
      .get(`${path}?timeout=5000`)
      .set("x-timeout-ms", "60000");
    expect(response.status).toBe(400);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("logs the X-Integration header", async () => {
    await request(app).get(path).set("x-integration", "zapier");
    await vi.waitFor(() =>
      expect(mocks.log).toHaveBeenCalledWith(
        expect.objectContaining({ integration: "zapier" }),
      ),
    );
  });

  it("refuses a key in the URL and malformed queries", async () => {
    for (const query of [
      "api_key=fc-1",
      "zeroDataRetention=true",
      "filters=x&filters.country=US",
    ]) {
      const response = await request(app).get(`${path}?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("refuses credentials before the contract lookup, even when declared", async () => {
    mocks.optionTypes.mockResolvedValue(new Map([["key", "string"]]));
    for (const query of [
      "key=isbn",
      "options.token=next",
      "auth.api_key=x",
      "q=fc-1e914bb5895149f8b754f58e2d4650a7",
    ]) {
      const response = await request(app).get(`${path}?${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(mocks.optionTypes).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("refuses an oversized query before the contract lookup", async () => {
    const tags = Array.from({ length: 201 }, (_, i) => `tags=${i}`).join("&");
    const response = await request(app).get(`${path}?${tags}`);
    expect(response.status).toBe(400);
    expect(mocks.optionTypes).not.toHaveBeenCalled();
  });

  it("refuses teams with forced zero data retention", async () => {
    flags = { exchangeRetrieve: true, forceZDR: true };
    const response = await request(app).get(path);
    expect(response.status).toBe(400);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("executes nothing when the contract lookup fails", async () => {
    mocks.optionTypes.mockRejectedValue(new Error("down"));
    const response = await request(app).get(`${path}?limit=10`);
    expect(response.status).toBe(503);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});

describe("feedback next step", () => {
  const hint = feedbackEnv;
  const second = { provider: "sec", capability: "filings", options: {} };
  const answered = (item: object = call) => ({
    ...item,
    creditsCost: 1,
    data: { price: 1 },
  });
  const send = (body: object) => request(app).post("/v2/scrape").send(body);
  beforeEach(() => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    mocks.retrieve.mockResolvedValue(result([answered()]));
  });
  afterEach(() => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = false;
  });

  it("adds the next step beside the existing fields of a provider answer", async () => {
    const response = await send({ alexandria: call, origin: "mcp-cursor" });
    expect(response.body).toEqual({
      success: true,
      scrape_id: "scrape-1",
      data: {
        creditsCost: 0,
        alexandria: [
          {
            provider: "fred",
            capability: "categories/category",
            options: {},
            creditsCost: 1,
            data: { price: 1 },
            nextStep: {
              instruction: expect.stringContaining("firecrawl_feedback"),
              tool: "firecrawl_feedback",
              arguments: expect.objectContaining({ endpoint: "alexandria" }),
            },
          },
        ],
      },
    });
  });

  it("matches the caller: a command for the CLI, the request for the API", async () => {
    const cli = await send({ alexandria: call, integration: "cli" });
    expect(cli.body.data.alexandria[0].nextStep.command).toMatch(
      /^firecrawl alexandria feedback /,
    );
    const direct = await send({ alexandria: call });
    expect(direct.body.data.alexandria[0].nextStep.request).toBe(
      "POST /v2/feedback",
    );
  });

  it("adds it once per response, on the first provider answer", async () => {
    mocks.retrieve.mockResolvedValue(
      result([
        { error: { code: "provider_error", message: "down" } },
        answered(),
        answered(second),
      ]),
    );
    const response = await send({ alexandria: [second, call, second] });
    expect(
      response.body.data.alexandria.map(
        (item: { nextStep?: unknown }) => item.nextStep !== undefined,
      ),
    ).toEqual([false, true, false]);
  });

  it("leaves out errors and Firecrawl's own calls, discovery included", async () => {
    const findTools = {
      provider: "firecrawl",
      capability: "find-tools",
      options: {},
    };
    mocks.retrieve.mockResolvedValue(
      result([
        { ...findTools, creditsCost: 0, data: { items: [] } },
        { error: { code: "provider_error", message: "down" } },
      ]),
    );
    const response = await send({ alexandria: [findTools, call] });
    expect(response.body.data.alexandria[0].nextStep).toBeUndefined();
    expect(response.body.data.alexandria[1].nextStep).toBeUndefined();
  });

  it("puts it on the legacy single-call answer too", async () => {
    const response = await request(app).post("/exchange/retrieve").send(call);
    expect(response.body.nextStep.request).toBe("POST /v2/feedback");
    expect(response.body.data).toEqual({ price: 1 });
  });

  it.each([
    [
      "the switch is off",
      () => (hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = false),
    ],
    [
      "the team opted out of feedback",
      () => (flags = { exchangeRetrieve: true, searchFeedbackOptOut: true }),
    ],
    ["the team is a preview team", () => (teamId = "preview_abc")],
    [
      "the team is under zero data retention",
      () => (flags = { exchangeRetrieve: true, forceZDR: true }),
    ],
  ])("adds nothing when %s", async (_case, arrange) => {
    arrange();
    const response = await send({ alexandria: call });
    expect(response.status).toBe(200);
    expect(response.body.data.alexandria[0]).toEqual({
      provider: "fred",
      capability: "categories/category",
      options: {},
      creditsCost: 1,
      data: { price: 1 },
    });
  });
});

describe("next step from Exchange", () => {
  const hint = feedbackEnv;
  const ifNotFound = {
    note: "<note>",
    call: {
      provider: "firecrawl",
      capability: "report-missing-data",
      options: { need: "<what you needed>", tried: "<what you tried>" },
    },
  };
  const answered = (extra: object = {}) => ({
    ...call,
    creditsCost: 1,
    data: { price: 1 },
    ...extra,
  });
  const send = () =>
    request(app)
      .post("/v2/scrape")
      .send({ alexandria: call, origin: "mcp-cursor" });
  afterEach(() => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = false;
  });

  it("keeps both next steps, the feedback keys first and unchanged", async () => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    mocks.retrieve.mockResolvedValue(
      result([answered({ nextStep: { ifNotFound } })]),
    );
    const [item] = (await send()).body.data.alexandria;
    expect(item).toEqual({
      ...answered(),
      nextStep: { ...alexandriaFeedbackNextStep("mcp-cursor"), ifNotFound },
    });
    expect(Object.keys(item.nextStep)).toEqual([
      "instruction",
      "tool",
      "arguments",
      "ifNotFound",
    ]);
  });

  it("adds only the feedback step when Exchange sends none", async () => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    mocks.retrieve.mockResolvedValue(result([answered()]));
    const [item] = (await send()).body.data.alexandria;
    expect(item).toEqual({
      ...answered(),
      nextStep: alexandriaFeedbackNextStep("mcp-cursor"),
    });
    expect(Object.keys(item.nextStep)).toEqual([
      "instruction",
      "tool",
      "arguments",
    ]);
  });

  it("returns Exchange's next step as sent when there is no feedback step", async () => {
    mocks.retrieve.mockResolvedValue(
      result([answered({ nextStep: { ifNotFound } })]),
    );
    const [item] = (await send()).body.data.alexandria;
    expect(item).toEqual(answered({ nextStep: { ifNotFound } }));
  });

  it("adds no next step when neither applies", async () => {
    mocks.retrieve.mockResolvedValue(result([answered()]));
    const [item] = (await send()).body.data.alexandria;
    expect(item).toEqual(answered());
  });

  it("never lets Exchange replace a feedback key", async () => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    mocks.retrieve.mockResolvedValue(
      result([
        answered({
          nextStep: { instruction: "other", tool: "other", ifNotFound },
        }),
      ]),
    );
    const [item] = (await send()).body.data.alexandria;
    expect(item.nextStep).toEqual({
      ...alexandriaFeedbackNextStep("mcp-cursor"),
      ifNotFound,
    });
  });

  it("keeps Exchange's next step on results the feedback step skips, under zero data retention too", async () => {
    hint.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    const failed = {
      error: { code: "not_found", message: "Nothing found." },
      nextStep: { ifNotFound },
    };
    mocks.retrieve.mockResolvedValue(result([failed, answered()]));
    const response = await request(app)
      .post("/v2/scrape")
      .send({ alexandria: [call, call] });
    expect(response.body.data.alexandria[0]).toEqual(failed);
    expect(response.body.data.alexandria[1].nextStep).toEqual(
      alexandriaFeedbackNextStep("api"),
    );

    mocks.retrieve.mockResolvedValue(
      result([answered({ nextStep: { ifNotFound } })]),
    );
    const retained = await request(app)
      .post("/v2/scrape")
      .send({ alexandria: call, zeroDataRetention: true });
    expect(retained.body.data.alexandria[0]).toEqual(
      answered({ nextStep: { ifNotFound } }),
    );
  });

  it("includes it in the error body of a failed legacy single call", async () => {
    mocks.retrieve.mockResolvedValue(
      result([
        {
          ...call,
          creditsCost: 0,
          error: { code: "not_found", message: "Nothing found.", status: 404 },
          nextStep: { ifNotFound },
        },
      ]),
    );
    const response = await request(app).post("/exchange/retrieve").send(call);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      code: "not_found",
      error: "Nothing found.",
      nextStep: { ifNotFound },
    });
  });
});

describe("caller labels for Exchange", () => {
  const sent = () => mocks.retrieve.mock.calls.at(-1)![0];

  it("passes on the origin and integration the request names", async () => {
    await request(app)
      .post("/v2/scrape")
      .send({ alexandria: call, origin: "mcp-cursor", integration: "n8n" });
    expect(sent()).toMatchObject({
      clientOrigin: "mcp-cursor",
      clientIntegration: "n8n",
    });
  });

  it("reads them from the headers on the flat route, which takes no origin in its body", async () => {
    await request(app)
      .post("/v2/alexandria")
      .set("x-origin", "cli")
      .set("x-integration", "zapier")
      .send(call);
    expect(sent()).toMatchObject({
      clientOrigin: "cli",
      clientIntegration: "zapier",
    });
  });

  it.each(["/v2/scrape", "/v2/alexandria"])(
    "names neither on %s when the request does not",
    async path => {
      await request(app)
        .post(path)
        .send(path === "/v2/scrape" ? { alexandria: call } : call);
      expect(mocks.retrieve).toHaveBeenCalledTimes(1);
      expect(sent()).not.toHaveProperty("clientOrigin");
      expect(sent()).not.toHaveProperty("clientIntegration");
    },
  );
});

describe("a free Firecrawl capability", () => {
  const report = {
    provider: "firecrawl",
    capability: "report-missing-data",
    options: { need: "<what was needed>", tried: "<what was tried>" },
  };
  const answer = {
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
  };
  beforeEach(() => {
    feedbackEnv.ALEXANDRIA_FEEDBACK_HINT_ENABLED = true;
    mocks.retrieve.mockResolvedValue(result([answer]));
  });
  afterEach(() => {
    feedbackEnv.ALEXANDRIA_FEEDBACK_HINT_ENABLED = false;
  });

  it("returns the answer unchanged on every route and charges nothing", async () => {
    const batch = await request(app)
      .post("/v2/scrape")
      .send({ alexandria: report });
    expect(batch.status).toBe(200);
    expect(batch.body).toEqual({
      success: true,
      scrape_id: "scrape-1",
      data: { alexandria: [answer], creditsCost: 0 },
    });
    const single = await request(app).post("/v2/alexandria").send(report);
    expect(single.status).toBe(200);
    expect(single.body).toEqual({ success: true, ...answer });
    expect(mocks.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({ calls: [report] }),
    );
  });

  it("logs the call with no credits and none of its options", async () => {
    await request(app).post("/v2/alexandria").send(report);
    await vi.waitFor(() =>
      expect(mocks.scrapeLog).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "alexandria:firecrawl/report-missing-data",
          credits_cost: 0,
          is_successful: true,
          options: {
            alexandria: [
              {
                provider: report.provider,
                capability: report.capability,
                code: null,
                creditsCost: 0,
              },
            ],
          },
        }),
      ),
    );
  });
});
