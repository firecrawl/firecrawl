import express from "express";
import request from "supertest";

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: {},
  CREDITS_FEATURE_ID: "CREDITS",
}));
vi.mock("../../services/autumn/usage", () => ({ getTeamBalance: vi.fn() }));
vi.mock("../../lib/http-metrics", () => ({
  httpRequestDurationSeconds: { observe: vi.fn() },
  getRoutePattern: vi.fn(),
}));
vi.mock("../../controllers/auth", () => ({ authenticateUser: vi.fn() }));
vi.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: vi.fn(),
}));
vi.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: vi.fn(),
}));
vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { authenticateUser } from "../../controllers/auth";
import { authMiddleware } from "../../routes/shared";
import { RateLimiterMode } from "../../types";

const app = express();
app.post("/v2/search", authMiddleware(RateLimiterMode.Search), (_req, res) => {
  res.json({ success: true });
});

describe("authentication rate-limit responses", () => {
  it.each([2, 42])(
    "returns a matching Retry-After header and JSON delay of %i seconds",
    async seconds => {
      vi.mocked(authenticateUser).mockResolvedValue({
        success: false,
        status: 429,
        error: "Rate limit exceeded",
        retryAfterSeconds: seconds,
      });

      const response = await request(app).post("/v2/search");

      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe(String(seconds));
      expect(response.body).toEqual({
        success: false,
        error: "Rate limit exceeded",
        retry_after_seconds: seconds,
      });
    },
  );

  it("does not invent a retry delay when authentication supplies none", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      status: 429,
      error: "Rate limit exceeded",
    });
    const response = await request(app).post("/v2/search");
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.body.retry_after_seconds).toBeUndefined();
  });

  it("does not attach a retry delay to an invalid API key", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: false,
      status: 401,
      error: "Unauthorized",
    });
    const response = await request(app).post("/v2/search");
    expect(response.status).toBe(401);
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  it("continues authenticated requests without a retry header", async () => {
    vi.mocked(authenticateUser).mockResolvedValue({
      success: true,
      team_id: "team-test",
      org_id: "org-test",
      chunk: null,
    });
    const response = await request(app).post("/v2/search");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(response.headers["retry-after"]).toBeUndefined();
  });
});
