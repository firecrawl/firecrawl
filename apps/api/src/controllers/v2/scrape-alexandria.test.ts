import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  log: vi.fn(),
  scrapeLog: vi.fn(),
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
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: "team" },
    acuc: {
      api_key_id: 12,
      org_id: "org",
      flags: { exchangeRetrieve: true },
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
  mocks.log.mockResolvedValue(undefined);
  mocks.scrapeLog.mockResolvedValue(undefined);
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

it("only lets trusted agent interop bypass billing, and prefers its request id", async () => {
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
    expect.objectContaining({ requestId: "agent-id", bypassBilling: true }),
  );
  expect(mocks.log).not.toHaveBeenCalled();
  expect(mocks.scrapeLog).not.toHaveBeenCalled();
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
    alexandria: [{ provider: call.provider, capability: call.capability }],
  });
});
