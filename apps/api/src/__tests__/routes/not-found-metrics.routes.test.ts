import express from "express";
import request from "supertest";

vi.mock("../../services/autumn/autumn.service", () => ({
  autumnService: { checkCredits: vi.fn() },
  CREDITS_FEATURE_ID: "CREDITS",
}));
vi.mock("../../services/autumn/usage", () => ({
  getTeamBalance: vi.fn(),
}));
vi.mock("../../controllers/auth", () => ({
  authenticateUser: vi.fn(),
}));
vi.mock("../../services/idempotency/create", () => ({
  createIdempotencyKey: vi.fn(),
}));
vi.mock("../../services/idempotency/validate", () => ({
  validateIdempotencyKey: vi.fn(),
}));
vi.mock("geoip-country", () => ({ lookup: vi.fn(() => null) }));

import { notFoundHandler } from "../../lib/not-found";
import { httpRequestDurationSeconds } from "../../lib/http-metrics";
import { requestTimingMiddleware } from "../../routes/shared";

// The real timing middleware patches res.json, so every JSON answer produced
// after it runs -- including the terminal 404/405 -- is observed by the
// histogram. Unmatched paths must not mint a new time series per URL.
function appUnderTest() {
  const app = express();

  const v2 = express.Router();
  v2.use(requestTimingMiddleware("v2"));
  v2.post("/scrape", (_req, res) => res.status(200).json({ success: true }));
  // Mirrors the real /v2/crawl/:jobId table (src/routes/v2.ts): only GET and
  // DELETE are registered, never PATCH.
  v2.get("/crawl/:jobId", (_req, res) => res.status(200).json({ success: true }));
  v2.delete("/crawl/:jobId", (_req, res) => res.status(200).json({ success: true }));

  app.use("/v2", v2);
  app.use(notFoundHandler);
  return app;
}

async function recordedRoutes(): Promise<string[]> {
  const metric = await httpRequestDurationSeconds.get();
  return metric.values
    .filter(value => value.metricName === "http_request_duration_seconds_count")
    .map(value => String(value.labels.route));
}

describe("not-found handler metric labels", () => {
  beforeEach(() => {
    httpRequestDurationSeconds.reset();
  });

  it("labels unknown paths with a single constant instead of the raw path", async () => {
    const app = appUnderTest();

    await request(app).get("/v2/wp-login.php");
    await request(app).get("/v2/.env");
    await request(app).get("/v2/some/deep/scanner/path");

    const routes = await recordedRoutes();

    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes)).toEqual(new Set(["unmatched"]));
  });

  it("labels wrong-method hits on a static path with the same constant", async () => {
    const app = appUnderTest();

    await request(app).get("/v2/scrape");
    await request(app).delete("/v2/scrape");

    const routes = await recordedRoutes();

    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes)).toEqual(new Set(["unmatched"]));
  });

  it("labels a wrong-method hit on a genuinely parameterised path with the same constant", async () => {
    const app = appUnderTest();

    // PATCH is not registered for /v2/crawl/:jobId -- only GET and DELETE are.
    const res = await request(app).patch("/v2/crawl/abc-123");

    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("DELETE, GET, HEAD");
    expect(res.body).toEqual({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      error:
        "PATCH /v2/crawl/abc-123 is not supported. Use DELETE, GET, HEAD instead.",
      allowed_methods: ["DELETE", "GET", "HEAD"],
      documentation_url:
        "https://docs.firecrawl.dev/api-reference/introduction",
    });

    const routes = await recordedRoutes();

    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes)).toEqual(new Set(["unmatched"]));
  });

  it("leaves the label of a matched route untouched", async () => {
    const app = appUnderTest();

    await request(app).post("/v2/scrape");

    expect(await recordedRoutes()).toEqual(["/scrape"]);
  });
});

describe("terminal not-found handler security headers", () => {
  it("sets nosniff on the JSON 404", async () => {
    const res = await request(appUnderTest()).get("/v2/nonexistent-xyz");

    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toEqual({
      success: false,
      code: "NOT_FOUND",
      error: "GET /v2/nonexistent-xyz is not a Firecrawl API endpoint.",
      documentation_url:
        "https://docs.firecrawl.dev/api-reference/introduction",
    });
  });

  it("sets nosniff on the JSON 405", async () => {
    const res = await request(appUnderTest()).get("/v2/scrape");

    expect(res.status).toBe(405);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toEqual({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      error: "GET /v2/scrape is not supported. Use POST instead.",
      allowed_methods: ["POST"],
      documentation_url:
        "https://docs.firecrawl.dev/api-reference/introduction",
    });
  });
});
