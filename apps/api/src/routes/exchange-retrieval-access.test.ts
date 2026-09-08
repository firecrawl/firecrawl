import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ enabled: false, fetch: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {}, fetch: mocked.fetch }));
vi.mock("../config", () => ({ config: { FIRE_EXCHANGE_URL: "http://exchange.test" } }));
vi.mock("../lib/logger", () => ({ logger: { child: () => ({ error: vi.fn() }) } }));
vi.mock("./exchange-blocklist", () => ({ bountyBlocklistMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("./shared", () => ({
  authMiddleware: () => (req: any, _res: unknown, next: () => void) => {
    req.auth = { team_id: "authenticated-team" };
    req.acuc = { flags: { exchangeRetrieve: mocked.enabled } };
    next();
  },
  wrap: (handler: unknown) => handler,
}));
import { exchangeRouter } from "./exchange";
const app = express().use(express.json()).use("/exchange", exchangeRouter);
beforeEach(() => {
  mocked.fetch.mockReset();
  mocked.fetch.mockResolvedValue({ status: 200, headers: new Headers(), text: async () => "{}" });
});
it.each([true, false])("forwards authenticated retrieval access=%s instead of caller headers", async enabled => {
  mocked.enabled = enabled;
  await request(app).post("/exchange/publisher/bounties")
    .set("x-exchange-retrieval-enabled", enabled ? "false" : "true")
    .set("x-exchange-team-id", "forged-team").send({ title: "Test bounty" }).expect(200);
  expect(mocked.fetch.mock.calls[0][1].headers).toMatchObject({
    "x-exchange-team-id": "authenticated-team",
    "x-exchange-retrieval-enabled": String(enabled),
  });
});
