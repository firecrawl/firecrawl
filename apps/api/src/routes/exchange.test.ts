import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocks.fetch }));
vi.mock("../config", () => ({
  config: { FIRE_EXCHANGE_URL: "http://exchange.test" },
}));
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));
vi.mock("./exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../controllers/v2/scrape-alexandria", () => ({
  providerScrapeController: vi.fn(),
}));
vi.mock("../lib/team-org", () => ({ orgIdFromAcuc: () => null }));
vi.mock("../services/alexandria/terms", () => ({
  acceptProviderTerms: vi.fn(),
  acceptTermsSchema: {},
}));
vi.mock("./shared", () => ({
  authMiddleware: () => (req: any, res: any, next: any) => {
    if (!req.headers.authorization)
      return res.status(401).json({ success: false });
    req.auth = { team_id: "test-team" };
    req.acuc = { flags: {} };
    next();
  },
  wrap: (handler: any) => handler,
}));

import { exchangeRouter } from "./exchange";
const app = express();
app.use(express.json());
app.use("/exchange", exchangeRouter);
beforeEach(() => mocks.fetch.mockReset());

it("proxies terms reads for authenticated teams without exchangeRetrieve", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ providers: [] }));
  const response = await request(app)
    .get("/exchange/provider-terms")
    .set("Authorization", "Bearer test");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ providers: [] });
  expect(mocks.fetch).toHaveBeenCalledWith(
    "http://exchange.test/v1/provider-terms",
    expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ "x-exchange-team-id": "test-team" }),
    }),
  );
});

it("still requires authentication for terms reads", async () => {
  expect((await request(app).get("/exchange/provider-terms")).status).toBe(401);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("keeps the retrieve flag on terms event writes", async () => {
  const response = await request(app)
    .post("/exchange/provider-terms/events")
    .set("Authorization", "Bearer test")
    .send({});
  expect(response.status).toBe(403);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
