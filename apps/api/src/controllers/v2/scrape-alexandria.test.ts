import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  restriction: vi.fn(),
  endpoint: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../services/alexandria/retrieve", () => ({
  retrieveProviders: mocks.retrieve,
}));
vi.mock("../../services/logging/log_job", () => ({ logRequest: mocks.log }));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: mocks.restriction,
  checkKeyEndpointRestriction: mocks.endpoint,
}));
vi.mock("../../lib/agent-interop", () => ({
  isAgentInteropSecretValid: (value: string) => value === "test-secret",
}));
vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.test" },
}));
import { providerScrapeController } from "./scrape-alexandria";
const call = {
  provider: "fred",
  capability: "categories/category",
  options: {},
};
let flags: Record<string, unknown>;
let sponsor: Record<string, unknown> | undefined;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, {
    auth: { team_id: "team" },
    acuc: { api_key_id: 12, org_id: "org", flags, _agentSponsor: sponsor },
  });
  next();
});
app.post("/v2/scrape", (req, res) => providerScrapeController(req as any, res));
app.post("/exchange/retrieve", (req, res) =>
  providerScrapeController(req as any, res, true),
);
beforeEach(() => {
  vi.clearAllMocks();
  flags = { exchangeRetrieve: true };
  sponsor = undefined;
  mocks.restriction.mockResolvedValue({ allowed: true });
  mocks.endpoint.mockResolvedValue({ allowed: true });
  mocks.log.mockResolvedValue(undefined);
  mocks.retrieve.mockResolvedValue({
    status: 200,
    body: {
      success: true,
      creditsCost: 0,
      results: [{ ...call, creditsCost: 0, data: {} }],
    },
  });
});

it("accepts a single tool and returns the unified scrape interface", async () => {
  const result = await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "same-request")
    .send({ exchange: call });
  expect(result.status).toBe(200);
  expect(result.body.data.exchange).toHaveLength(1);
  expect(result.body.data.creditsCost).toBe(0);
  expect(result.headers["x-request-id"]).toBe("same-request");
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({
      calls: [call],
      requestId: "same-request",
      apiKeyId: 12,
    }),
  );
});

it("uses the same normalized request on both provider routes", async () => {
  await request(app)
    .post("/v2/scrape")
    .set("x-request-id", "same")
    .send({ exchange: call });
  await request(app)
    .post("/exchange/retrieve")
    .set("x-request-id", "same")
    .send(call);
  expect(mocks.retrieve.mock.calls[0][0]).toEqual(
    mocks.retrieve.mock.calls[1][0],
  );
});

it.each([
  { exchange: [] },
  { exchange: Array(11).fill(call) },
  { exchange: call, url: "https://example.com" },
  { exchange: call, timeout: -1 },
])("rejects malformed provider requests", async body => {
  expect((await request(app).post("/v2/scrape").send(body)).status).toBe(400);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});

it.each([
  {},
  { exchangeRetrieve: true, scrapeZDR: "forced" },
  { exchangeRetrieve: true, forceZDR: true },
])("enforces access and forced retention before queueing", async value => {
  flags = value;
  expect(
    (await request(app).post("/v2/scrape").send({ exchange: call })).status,
  ).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});

it.each(["pending", "blocked"])("rejects %s sponsored keys", async status => {
  sponsor = { status };
  expect(
    (await request(app).post("/exchange/retrieve").send(call)).status,
  ).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});

it("does not let untrusted callers bypass paid billing", async () => {
  expect(
    (
      await request(app)
        .post("/v2/scrape")
        .send({
          exchange: call,
          __agentInterop: {
            auth: "wrong",
            requestId: "same",
            shouldBill: false,
          },
        })
    ).status,
  ).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});

it("preserves trusted agent billing ownership without storing its secret", async () => {
  await request(app)
    .post("/v2/scrape")
    .send({
      exchange: call,
      __agentInterop: {
        auth: "test-secret",
        requestId: "agent-job",
        shouldBill: false,
      },
    });
  expect(mocks.retrieve).toHaveBeenCalledWith(
    expect.objectContaining({ bypassBilling: true, requestId: "agent-job" }),
  );
  expect(JSON.stringify(mocks.retrieve.mock.calls)).not.toContain(
    "test-secret",
  );
});

it("checks JSON output restrictions", async () => {
  mocks.restriction.mockResolvedValue({
    allowed: false,
    status: 403,
    error: "restricted",
  });
  expect(
    (await request(app).post("/v2/scrape").send({ exchange: call })).status,
  ).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});

it("cannot bypass Scrape endpoint restrictions through the legacy route", async () => {
  mocks.endpoint.mockResolvedValue({
    allowed: false,
    status: 403,
    error: "restricted endpoint",
  });
  expect(
    (await request(app).post("/exchange/retrieve").send(call)).status,
  ).toBe(403);
  expect(mocks.retrieve).not.toHaveBeenCalled();
});
