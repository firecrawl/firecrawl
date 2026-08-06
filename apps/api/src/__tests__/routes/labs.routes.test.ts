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

/**
 * Every path the Labs Search service serves, because this proxy forwards one route at a
 * time and a path missing here is a 404 no matter what the service does. The list was
 * pruned by accident once — a rate-limit change rewrote every route in the file and lost
 * five of them, taking provider packs off the dashboard until it was noticed by hand.
 * Adding a route upstream means adding it here too, and this list is the reminder.
 */
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

// Express populates `methods` on every route but does not declare it on IRoute.
type RouteWithMethods = { path: unknown; methods: Record<string, boolean> };

function registeredRoutes(): string[] {
  return labsRouter.stack.flatMap(layer => {
    const route = layer.route as RouteWithMethods | undefined;
    // The catch-all matches by regex and has no literal path; only named routes count.
    if (route === undefined || typeof route.path !== "string") return [];
    const path = route.path;
    return Object.keys(route.methods)
      .filter(method => method !== "_all")
      .map(method => `${method.toUpperCase()} ${path}`);
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
    // Called out separately from the list above so a deletion names what it broke.
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
    // GET /search/configs is proxied; PUT is not. The reply has to say which.
    const response = await request(appWithLabs()).put("/labs/search/configs");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("LABS_ROUTE_NOT_PROXIED");
    expect(response.body.error).toContain("PUT /labs/search/configs");
  });

  it("lets proxied routes through rather than swallowing them in the catch-all", async () => {
    const response = await request(appWithLabs()).get("/labs/search/packs");

    // The upstream fetch is unmocked and fails, but reaching the proxy at all proves the
    // catch-all sits behind the real routes instead of shadowing them.
    expect(response.body.code).not.toBe("LABS_ROUTE_NOT_PROXIED");
  });
});
