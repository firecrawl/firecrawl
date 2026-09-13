import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({ retrieve: vi.fn(), log: vi.fn() }));
vi.mock("../../services/alexandria/retrieve", () => ({
  REQUEST_ID_PATTERN: /^[A-Za-z0-9._:-]{1,128}$/,
  retrieveProviders: mocks.retrieve,
}));
vi.mock("../../services/logging/log_job", () => ({ logRequest: mocks.log }));
vi.mock("../../lib/key-restriction", () => ({
  checkKeyFormatRestriction: async () => ({ allowed: true }),
}));
vi.mock("../../lib/agent-interop", () => ({
  isAgentInteropSecretValid: (value: string) => value === "test-secret",
}));
vi.mock("../../config", () => ({
  config: {
    FIRE_EXCHANGE_URL: "https://x",
    AGENT_INTEROP_SECRET: "test-secret",
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
    acuc: { api_key_id: 12, flags: { exchangeRetrieve: true } },
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
  expect(mocks.log).toHaveBeenCalledTimes(1);
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
});
