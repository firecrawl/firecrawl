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
beforeEach(() => {
  vi.clearAllMocks();
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

it("returns the Scrape contract and shares request identity with the legacy route", async () => {
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
  await request(app)
    .post("/exchange/retrieve")
    .set("x-request-id", "same-request")
    .send(call);
  expect(mocks.retrieve.mock.calls[0][0]).toEqual(
    mocks.retrieve.mock.calls[1][0],
  );
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
