import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (_q: any, _s: any, next: any) => next(),
}));
vi.mock("../controllers/v2/scrape-alexandria", () => ({
  providerScrapeController: vi.fn(),
}));
vi.mock("../lib/team-org", () => ({ orgIdFromAcuc: vi.fn() }));
vi.mock("../services/alexandria/terms", () => ({
  acceptProviderTerms: vi.fn(),
  acceptTermsSchema: {},
}));
vi.mock("../config", () => ({
  config: { FIRE_EXCHANGE_URL: "http://exchange.internal" },
}));
vi.mock("../lib/logger", () => ({
  logger: { child: () => ({ error: vi.fn() }) },
}));
vi.mock("undici", () => ({ Agent: class {}, fetch: vi.fn() }));
vi.mock("./shared", () => ({
  authMiddleware: () => (req: any, res: any, next: any) => {
    if (req.headers.authorization !== "Bearer test") return res.sendStatus(401);
    req.auth = { team_id: "authenticated-team" };
    req.acuc = { flags: { exchangeRetrieve: false } };
    next();
  },
  wrap: (fn: any) => fn,
}));
import { fetch } from "undici";
import { exchangeRouter } from "./exchange";
const app = express().use(express.json()).use("/exchange", exchangeRouter);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetch).mockResolvedValue(
    new Response('{"success":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as any,
  );
});
it.each([
  ["put", "buckets/fullenrich"],
  ["put", "buckets/fullenrich/teams/team-1"],
  ["put", "plan-weights"],
  ["delete", "buckets/fullenrich"],
  ["delete", "buckets/fullenrich/teams/team-1"],
] as const)(
  "proxies %s %s without retrieve flag using authenticated identity",
  async (method, path) => {
    const body = { class: "B", perMinute: 180 };
    const response = await request(app)
      [method](`/exchange/platform/capacity/${path}`)
      .set("Authorization", "Bearer test")
      .set("x-exchange-team-id", "spoofed")
      .set("x-exchange-secret", "spoofed")
      .send(body);
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      `http://exchange.internal/v1/platform/capacity/${path}`,
      expect.objectContaining({
        method: method.toUpperCase(),
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-exchange-team-id": "authenticated-team",
        },
      }),
    );
  },
);
it("rejects unauthenticated writes", async () => {
  expect(
    (
      await request(app)
        .put("/exchange/platform/capacity/buckets/fullenrich")
        .send({})
    ).status,
  ).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves upstream staff refusal", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response('{"code":"unauthorized"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }) as any,
  );
  const response = await request(app)
    .put("/exchange/platform/capacity/buckets/fullenrich")
    .set("Authorization", "Bearer test")
    .send({});
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ code: "unauthorized" });
});
it("does not expose unrelated writes", async () => {
  expect(
    (
      await request(app)
        .put("/exchange/platform/other")
        .set("Authorization", "Bearer test")
        .send({})
    ).status,
  ).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
