import express from "express";
import request from "supertest";

vi.mock("../../config", () => ({
  config: {
    LABS_SEARCH_URL: "https://labs.test",
    LABS_SEARCH_SECRET: "test-secret",
  },
}));

vi.mock("../../lib/logger", () => {
  const logger = {
    child: () => logger,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { logger };
});

vi.mock("../../routes/shared", () => ({
  authMiddleware: () => (_req: any, _res: any, next: any) => next(),
  wrap: (fn: any) => fn,
}));

import { labsRouter } from "../../routes/labs";

const LABS_ROUTES = [
  "POST /search",
  "POST /search/data/sites",
  "POST /search/data/documents",
  "POST /search/data/pages",
  "GET /search/data",
  "PATCH /search/data/:sourceId",
  "DELETE /search/data/:sourceId",
  "POST /search/data/:sourceId/refresh",
  "GET /search/providers",
  "GET /search/packs",
  "PATCH /search/packs/:packId",
  "POST /search/configs",
  "GET /search/configs",
  "PATCH /search/configs/:id",
  "DELETE /search/configs/:id",
];

function registeredRoutes(): string[] {
  return labsRouter.stack.flatMap(layer => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== "string") return [];
    const path = route.path;
    const methods = new Set(route.stack.map(entry => entry.method));
    return [...methods].map(method => `${method.toUpperCase()} ${path}`);
  });
}

function appWithLabs() {
  const app = express();
  app.use("/labs", labsRouter);
  return app;
}

describe("labs router", () => {
  it("proxies every route the Labs Search service serves", () => {
    expect(registeredRoutes().sort()).toEqual([...LABS_ROUTES].sort());
  });

  it("keeps the provider pack routes the dashboard reads", () => {
    expect(registeredRoutes()).toContain("GET /search/packs");
    expect(registeredRoutes()).toContain("PATCH /search/packs/:packId");
  });

  it("answers an unproxied labs path with JSON naming the gap", async () => {
    const response = await request(appWithLabs()).get(
      "/labs/search/not-a-route",
    );

    expect(response.status).toBe(404);
    expect(response.type).toBe("application/json");
    expect(response.body.code).toBe("LABS_ROUTE_NOT_PROXIED");
    expect(response.body.error).toContain("/labs/search/not-a-route");
    expect(response.body.error).toContain("does not forward it yet");
  });

  it("names the method so a wrong-verb route is not read as a missing record", async () => {
    const response = await request(appWithLabs()).put("/labs/search/configs");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("LABS_ROUTE_NOT_PROXIED");
    expect(response.body.error).toContain("PUT /labs/search/configs");
  });

  it("lets proxied routes through rather than swallowing them in the catch-all", async () => {
    const response = await request(appWithLabs()).get("/labs/search/packs");

    expect(response.body.code).not.toBe("LABS_ROUTE_NOT_PROXIED");
  });
});
