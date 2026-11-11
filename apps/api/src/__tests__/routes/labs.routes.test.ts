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

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  flags: {} as Record<string, unknown>,
}));

vi.mock("undici", async importOriginal => ({
  ...(await importOriginal<typeof import("undici")>()),
  fetch: mocks.fetch,
}));

vi.mock("../../routes/shared", () => ({
  authMiddleware: () => (req: any, _res: any, next: any) => {
    req.auth = { team_id: "team-1" };
    req.acuc = { flags: mocks.flags };
    next();
  },
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

describe("labs router for a US-only team", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });

  it.each(LABS_ROUTES)(
    "refuses %s without calling the labs service",
    async route => {
      mocks.flags = { labsSearch: true, usOnly: true };
      const [method, path] = route.split(" ");

      const response = await (request(appWithLabs()) as any)[
        method.toLowerCase()
      ]("/labs" + path.replace(/:\w+/g, "id-1"));

      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        code: "US_ONLY_UNAVAILABLE",
        error:
          "Labs Search is not available for teams restricted to US-only processing.",
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("still proxies for a team without the US-only restriction", async () => {
    mocks.flags = { labsSearch: true };
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await request(appWithLabs()).post("/labs/search");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, results: [] });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe("https://labs.test/labs/search");
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      "x-labs-search-team-id": "team-1",
    });
  });
});
