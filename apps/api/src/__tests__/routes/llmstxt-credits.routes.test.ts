import express from "express";
import request from "supertest";

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

// Real router and middlewares; auth is stubbed and the credit check ends the
// chain with a 204, so a 204 means the route runs the credit check before
// its controller.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("../../routes/shared")>();
  return {
    ...actual,
    authMiddleware: () => (req: any, _res: any, next: any) => {
      req.auth = { team_id: "team-1" };
      req.acuc = { flags: {} };
      next();
    },
    checkCreditsMiddleware: () => (_req: any, res: any) =>
      res.status(204).end(),
  };
});

import { v1Router } from "../../routes/v1";

const app = express();
app.use(express.json());
app.use("/v1", v1Router);

describe("POST /v1/llmstxt", () => {
  it("runs the credit check before starting a generation", async () => {
    const res = await request(app)
      .post("/v1/llmstxt")
      .send({ url: "https://example.com" });

    expect(res.status).toBe(204);
  });
});
