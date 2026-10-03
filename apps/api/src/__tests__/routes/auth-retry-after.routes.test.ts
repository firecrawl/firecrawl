import express from "express";
import request from "supertest";

vi.mock("../../controllers/auth", () => ({ authenticateUser: vi.fn() }));

import { authenticateUser } from "../../controllers/auth";
import { authMiddleware } from "../../routes/shared";
import { RateLimiterMode } from "../../types";

function app() {
  const app = express();
  app.get("/v2/scrape", authMiddleware(RateLimiterMode.Scrape), (_req, res) =>
    res.status(200).json({ success: true }),
  );
  return app;
}

describe("authMiddleware rate-limit responses", () => {
  it("sends Retry-After and retry_after_seconds on a 429", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      error: "Rate limit exceeded.",
      status: 429,
      retryAfterSeconds: 12,
    });

    const res = await request(app()).get("/v2/scrape");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.body).toMatchObject({ success: false, retry_after_seconds: 12 });
  });

  it("omits Retry-After when the failure has no retry hint", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      error: "Unauthorized",
      status: 401,
    });

    const res = await request(app()).get("/v2/scrape");

    expect(res.status).toBe(401);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.body).not.toHaveProperty("retry_after_seconds");
  });
});
