import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { requestIdMiddleware } from "./request-id";

describe("requestIdMiddleware", () => {
  function createApp() {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/ok", (req, res) => res.json({ requestId: req.requestId }));
    app.get("/error", (_req, _res, next) => next(new Error("test error")));
    app.use((_error: unknown, _req, res, _next) =>
      res.status(500).json({ success: false }),
    );
    return app;
  }

  it("returns and attaches the incoming request ID", async () => {
    const response = await request(createApp())
      .get("/ok")
      .set("X-Request-ID", "client-request-123");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe("client-request-123");
    expect(response.body.requestId).toBe("client-request-123");
  });

  it("generates a request ID when one is not provided", async () => {
    const response = await request(createApp()).get("/ok");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.body.requestId).toBe(response.headers["x-request-id"]);
  });

  it("returns a generated ID for error responses", async () => {
    const response = await request(createApp()).get("/error");

    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("replaces an oversized incoming ID", async () => {
    const response = await request(createApp())
      .get("/ok")
      .set("X-Request-ID", "a".repeat(257));

    expect(response.headers["x-request-id"]).not.toBe("a".repeat(257));
  });
});
