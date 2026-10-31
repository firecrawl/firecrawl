import express from "express";
import request from "supertest";

vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

// Real router and middlewares; auth is stubbed and the credit check ends the
// chain with a 200 that carries the minimum it was built with. That response
// proves the route runs the credit check before its controller, and with the
// expected minimum.
vi.mock("../../routes/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("../../routes/shared")>();
  return {
    ...actual,
    authMiddleware: () => (req: any, _res: any, next: any) => {
      req.auth = { team_id: "team-1" };
      req.acuc = { flags: {} };
      next();
    },
    checkCreditsMiddleware: (minimum?: number) => (_req: any, res: any) =>
      res.status(200).json({ creditsRequired: minimum }),
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

    expect(res.status).toBe(200);
    // The route's deprecation middleware adds its notice to the body, so
    // check the one key the credit-check stub wrote.
    expect(res.body.creditsRequired).toBe(1);
  });
});
