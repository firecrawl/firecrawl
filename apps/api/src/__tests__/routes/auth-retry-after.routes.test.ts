import express from "express";
import request from "supertest";

vi.mock("../../controllers/auth", () => ({
  authenticateUser: vi.fn(),
}));

import { authenticateUser } from "../../controllers/auth";
import { authMiddleware } from "../../routes/shared";
import { RateLimiterMode } from "../../types";

function appWithAuth() {
  const app = express();
  app.get("/v2/scrape", authMiddleware(RateLimiterMode.Scrape), (_req, res) =>
    res.status(200).json({ success: true }),
  );
  return app;
}

describe("authMiddleware 429s", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends Retry-After and retry_after_seconds when auth reports a reset", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      error: "Rate limit exceeded. Please retry after 42s",
      status: 429,
      retryAfterSeconds: 42,
    });

    const response = await request(appWithAuth()).get("/v2/scrape");

    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("42");
    expect(response.body).toEqual({
      success: false,
      error: "Rate limit exceeded. Please retry after 42s",
      retry_after_seconds: 42,
    });
  });

  it("omits Retry-After when auth reports no reset", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      error: "Unauthorized: Invalid token",
      status: 401,
    });

    const response = await request(appWithAuth()).get("/v2/scrape");

    expect(response.status).toBe(401);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.body.retry_after_seconds).toBeUndefined();
  });
});
