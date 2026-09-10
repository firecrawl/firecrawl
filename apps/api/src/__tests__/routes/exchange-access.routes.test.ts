import express from "express";
import request from "supertest";
import { fetch } from "undici";

const state = vi.hoisted(() => ({ access: true as unknown }));

vi.mock("../../config", () => ({
  config: { FIRE_EXCHANGE_URL: "https://exchange.internal" },
}));
vi.mock("../../lib/logger", () => {
  const logger = { child: () => logger, error: vi.fn() };
  return { logger };
});
vi.mock("undici", () => ({ Agent: class {}, fetch: vi.fn() }));
vi.mock("../../routes/exchange-blocklist", () => ({
  bountyBlocklistMiddleware: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../routes/shared", () => ({
  authMiddleware: () => (req: any, _res: unknown, next: () => void) => {
    req.auth = { team_id: "authenticated-team" };
    req.acuc = { flags: { exchangeRetrieve: state.access } };
    next();
  },
  wrap: (fn: unknown) => fn,
}));

import { exchangeRouter } from "../../routes/exchange";

function app() {
  const app = express();
  app.use(express.json());
  app.use("/exchange", exchangeRouter);
  return app;
}

beforeEach(() => {
  state.access = true;
  vi.mocked(fetch)
    .mockReset()
    .mockResolvedValue({
      status: 200,
      headers: new Headers({
        "cache-control": "no-store",
        "content-type": "application/json",
      }),
      text: async () => '{"cohorts":[]}',
    } as unknown as Awaited<ReturnType<typeof fetch>>);
});

it("derives extended catalogue access from authentication and preserves private cache policy", async () => {
  const response = await request(app())
    .get("/exchange/discover")
    .set("x-exchange-team-id", "spoofed-team")
    .set("x-exchange-extended-catalog-access", "false");
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(fetch).toHaveBeenCalledWith(
    "https://exchange.internal/v1/discover",
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-exchange-team-id": "authenticated-team",
        "x-exchange-extended-catalog-access": "true",
      }),
    }),
  );
});

it.each([false, undefined, "true"])(
  "does not grant extended catalogue access from client headers when the flag is %s",
  async access => {
    state.access = access;
    const response = await request(app())
      .get("/exchange/platform/catalogue?hasExtendedCatalogAccess=true")
      .set("x-exchange-extended-catalog-access", "true");
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-exchange-extended-catalog-access": "false",
        }),
      }),
    );
  },
);

it("keeps the existing retrieval gate even when the caller spoofs extended catalogue access", async () => {
  state.access = false;
  const response = await request(app())
    .post("/exchange/retrieve")
    .set("x-exchange-extended-catalog-access", "true")
    .send({
      provider: "preview-catalog",
      capability: "items/search",
      hasExtendedCatalogAccess: true,
    });
  expect(response.status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
