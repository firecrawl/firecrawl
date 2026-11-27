import express from "express";
import request from "supertest";
import { authMiddleware } from "../../routes/shared";
import { coreParts } from "../../service";
import type { AuthModule } from "../../service";
import { testService, withService } from "../../service/testing";
import { RateLimiterMode } from "../../types";

function appWithAuth() {
  const app = express();
  app.get("/v2/scrape", authMiddleware(RateLimiterMode.Scrape), (_req, res) =>
    res.status(200).json({ success: true }),
  );
  return app;
}

describe("authMiddleware refusals", () => {
  it("sends Retry-After and retry_after_seconds when auth refuses with a reset", async () => {
    const auth: AuthModule = {
      authenticate: async () => ({
        ok: false,
        refusal: {
          status: 429,
          headers: { "Retry-After": "42" },
          body: {
            success: false,
            error: "Rate limit exceeded. Please retry after 42s",
            retry_after_seconds: 42,
          },
        },
      }),
    };

    await withService(testService({}, coreParts(), { auth }), async () => {
      const response = await request(appWithAuth()).get("/v2/scrape");

      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBe("42");
      expect(response.body).toEqual({
        success: false,
        error: "Rate limit exceeded. Please retry after 42s",
        retry_after_seconds: 42,
      });
    });
  });

  it("omits Retry-After when auth refusal carries no reset header", async () => {
    const auth: AuthModule = {
      authenticate: async () => ({
        ok: false,
        refusal: {
          status: 401,
          body: {
            success: false,
            error: "Unauthorized: Invalid token",
          },
        },
      }),
    };

    await withService(testService({}, coreParts(), { auth }), async () => {
      const response = await request(appWithAuth()).get("/v2/scrape");

      expect(response.status).toBe(401);
      expect(response.headers["retry-after"]).toBeUndefined();
      expect(response.body.retry_after_seconds).toBeUndefined();
    });
  });

  it("passes WWW-Authenticate and refusal fields through verbatim", async () => {
    const auth: AuthModule = {
      authenticate: async () => ({
        ok: false,
        refusal: {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://example.test/.well-known"',
          },
          body: {
            success: false,
            error: "Unauthorized",
            signup_url: "https://example.test/signup",
          },
        },
      }),
    };

    await withService(testService({}, coreParts(), { auth }), async () => {
      const response = await request(appWithAuth()).get("/v2/scrape");

      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer resource_metadata="https://example.test/.well-known"',
      );
      expect(response.body).toEqual({
        success: false,
        error: "Unauthorized",
        signup_url: "https://example.test/signup",
      });
    });
  });
});
