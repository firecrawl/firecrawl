import express from "express";
import request from "supertest";
import { fetch } from "undici";

vi.mock("../types", () => ({
  RateLimiterMode: { Labs: "labs", Exchange: "exchange" },
}));
vi.mock("../lib/team-org", () => ({ orgIdFromAcuc: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {}, fetch: vi.fn() }));
vi.mock("../config", () => ({
  config: { FIRE_EXCHANGE_URL: "http://exchange.internal" },
}));
vi.mock("../lib/logger", () => {
  const logger = { error: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return { logger };
});
vi.mock("./exchange-blocklist", () => ({ bountyBlocklistMiddleware: vi.fn() }));
vi.mock("../controllers/v2/scrape-alexandria", () => ({
  providerScrapeController: vi.fn(),
}));
vi.mock("../services/alexandria/terms", () => ({
  acceptProviderTerms: vi.fn(),
  acceptTermsSchema: {},
}));
vi.mock("./shared", () => ({
  authMiddleware:
    (mode: string, options?: { skipRateLimit?: boolean }) =>
    (req: any, res: any, next: any) => {
      res.setHeader(
        "x-test-skip-rate-limit",
        String(options?.skipRateLimit === true),
      );
      res.setHeader("x-test-rate-mode", mode);
      if (!req.headers.authorization) return res.sendStatus(401);
      req.auth = { team_id: "authenticated-team" };
      req.acuc = { flags: { exchangeRetrieve: false } };
      next();
    },
  wrap: (handler: any) => handler,
}));
import { exchangeRouter } from "./exchange";
const app = express().use("/exchange", exchangeRouter);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetch).mockResolvedValue({
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify({ results: [] }),
  } as any);
});
it("forwards analytics without the rollout flag using authenticated team identity", async () => {
  const response = await request(app)
    .get("/exchange/analytics/providers?days=30")
    .set("Authorization", "Bearer test-key")
    .set("x-exchange-team-id", "spoofed-team");
  expect(response.status).toBe(200);
  expect(fetch).toHaveBeenCalledWith(
    "http://exchange.internal/v1/analytics/providers?days=30",
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-exchange-team-id": "authenticated-team",
      }),
    }),
  );
});
it("retains authentication middleware before proxying analytics", async () => {
  expect((await request(app).get("/exchange/analytics/summary")).status).toBe(
    401,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves upstream failures", async () => {
  vi.mocked(fetch).mockResolvedValue({
    status: 503,
    headers: new Headers(),
    text: async () => JSON.stringify({ error: "unavailable" }),
  } as any);
  expect(
    (
      await request(app)
        .get("/exchange/analytics/summary")
        .set("Authorization", "Bearer test-key")
    ).status,
  ).toBe(503);
});

it("disables catalog rate limiting without disabling authentication", async () => {
  const response = await request(app)
    .get("/exchange/discover/finance?expand=all&surface=web")
    .set("Authorization", "Bearer test-key");
  expect(response.status).toBe(200);
  expect(response.headers["x-test-skip-rate-limit"]).toBe("true");
  expect(fetch).toHaveBeenCalledWith(
    "http://exchange.internal/v1/discover/finance?expand=all&surface=web",
    expect.anything(),
  );
});
it("retains the execution budget and existing record-retrieval gate", async () => {
  const response = await request(app)
    .post("/exchange/records/fetch")
    .set("Authorization", "Bearer test-key");
  expect(response.headers["x-test-rate-mode"]).toBe("exchange");
  expect(response.headers["x-test-skip-rate-limit"]).toBe("false");
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
