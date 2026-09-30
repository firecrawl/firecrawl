import express from "express";
import request from "supertest";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
vi.mock("ioredis", () => ({
  default: class {
    on() {}
    defineCommand() {}
  },
}));
vi.mock("../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.example" },
}));
vi.mock("../services/alexandria/client", () => ({
  exchangePlanTier: mocks.plan,
}));
vi.mock("../controllers/v2/scrape-alexandria", () => ({
  providerScrapeController: vi.fn(),
}));
vi.mock("../services/alexandria/terms", () => ({
  acceptProviderTerms: vi.fn(),
  acceptTermsSchema: { safeParse: vi.fn() },
}));
vi.mock("./exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (_req, _res, next) => next(),
}));
vi.mock("./shared", () => ({
  authMiddleware: () => (req, _res, next) => {
    Object.assign(req, {
      auth: { team_id: "team", org_id: "org" },
      acuc: { flags: { exchangeRetrieve: true } },
    });
    next();
  },
  wrap: controller => (req, res, next) =>
    controller(req, res).catch(err => next(err)),
}));
import { exchangeRouter } from "./exchange";

const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);

beforeEach(() => {
  vi.clearAllMocks();
});

it("forwards the upstream Retry-After and sends the caller's plan", async () => {
  mocks.plan.mockResolvedValue("scale");
  mocks.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({ code: "provider_rate_limited", error: "Slow down." }),
      {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      },
    ),
  );
  const response = await request(app)
    .post("/exchange/records/fetch")
    .send({ url: "https://example.com" });
  expect(response.status).toBe(429);
  expect(response.headers["retry-after"]).toBe("30");
  expect(response.body).toEqual({
    code: "provider_rate_limited",
    error: "Slow down.",
  });
  expect(mocks.plan).toHaveBeenCalledWith("team", "org");
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("https://exchange.example/v1/records/fetch");
  expect(init.headers).toEqual(
    expect.objectContaining({
      "x-exchange-team-id": "team",
      "x-exchange-plan": "scale",
    }),
  );
});

it("omits the plan header when the plan is unknown", async () => {
  mocks.plan.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ tools: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const response = await request(app).get("/exchange/discover");
  expect(response.status).toBe(200);
  expect(response.headers["retry-after"]).toBeUndefined();
  expect(mocks.fetch.mock.calls[0][1].headers).not.toHaveProperty(
    "x-exchange-plan",
  );
});
