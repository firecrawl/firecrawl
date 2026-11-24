import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  buildRouteRegistry,
  type RouteRegistrar,
  type Routers,
} from "./routes";

describe("buildRouteRegistry", () => {
  it("mounts non-core extension routes before core routes so extensions can shadow or call next()", async () => {
    const order: string[] = [];

    const { mountRoutes } = buildRouteRegistry([
      {
        owner: "core",
        isCore: true,
        routes: ({ root, v2, admin }) => {
          order.push("core");
          root.get("/status", (_req, res) => {
            res.json({ from: "core-root" });
          });
          v2.get("/shadowed", (_req, res) => {
            res.json({ from: "core-v2" });
          });
          v2.get("/fallthrough", (_req, res) => {
            res.json({ from: "core-fallthrough", seen: res.locals.seen });
          });
          admin.get("/admin/check", (_req, res) => {
            res.json({ from: "core-admin" });
          });
        },
      },
      {
        owner: "first",
        routes: ({ v2, adminInternal }) => {
          order.push("first");
          v2.get("/shadowed", (_req, res) => {
            res.json({ from: "first" });
          });
          v2.get("/fallthrough", (_req, res, next) => {
            res.locals.seen = ["first"];
            next();
          });
          adminInternal?.get("/admin/internal-ping", (_req, res) => {
            res.json({ ok: true });
          });
        },
      },
      {
        owner: "second",
        routes: ({ v2 }) => {
          order.push("second");
          v2.get("/fallthrough", (_req, res, next) => {
            res.locals.seen = [...(res.locals.seen ?? []), "second"];
            next();
          });
          v2.get("/only-second", (_req, res) => {
            res.json({ from: "second" });
          });
        },
      },
    ]);

    const app = express();
    const v2 = express.Router();
    const admin = express.Router();
    const adminInternal = express.Router();

    mountRoutes({ root: app, v2, admin, adminInternal });
    app.use("/v2", v2);
    app.use(admin);

    const internalApp = express();
    internalApp.use(adminInternal);

    expect(order).toEqual(["first", "second", "core"]);

    const shadowed = await request(app).get("/v2/shadowed");
    expect(shadowed.status).toBe(200);
    expect(shadowed.body).toEqual({ from: "first" });

    const fallthrough = await request(app).get("/v2/fallthrough");
    expect(fallthrough.status).toBe(200);
    expect(fallthrough.body).toEqual({
      from: "core-fallthrough",
      seen: ["first", "second"],
    });

    const onlySecond = await request(app).get("/v2/only-second");
    expect(onlySecond.status).toBe(200);
    expect(onlySecond.body).toEqual({ from: "second" });

    const rootStatus = await request(app).get("/status");
    expect(rootStatus.status).toBe(200);
    expect(rootStatus.body).toEqual({ from: "core-root" });

    const adminCheck = await request(app).get("/admin/check");
    expect(adminCheck.status).toBe(200);
    expect(adminCheck.body).toEqual({ from: "core-admin" });

    const internalPing = await request(internalApp).get("/admin/internal-ping");
    expect(internalPing.status).toBe(200);
    expect(internalPing.body).toEqual({ ok: true });
  });

  it("works when core has no routes and only extensions register routes", () => {
    const order: string[] = [];
    const { mountRoutes } = buildRouteRegistry([
      { owner: "core", isCore: true },
      {
        owner: "ext-a",
        routes: () => {
          order.push("ext-a");
        },
      },
      {
        owner: "ext-b",
        routes: () => {
          order.push("ext-b");
        },
      },
    ]);

    mountRoutes({
      root: express.Router(),
      v2: express.Router(),
      admin: express.Router(),
    });

    expect(order).toEqual(["ext-a", "ext-b"]);
  });

  it("describes routes in mount order with owner, router, method, path, and middleware names", () => {
    function authGuard(
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) {
      next();
    }
    function ignoreError(
      _err: unknown,
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) {
      next();
    }
    function listItems(_req: express.Request, res: express.Response) {
      res.end();
    }
    function createItem(_req: express.Request, res: express.Response) {
      res.end();
    }
    function nestedHandler(_req: express.Request, res: express.Response) {
      res.end();
    }
    function coreScrape(_req: express.Request, res: express.Response) {
      res.end();
    }

    const registrar = vi.fn<RouteRegistrar>(
      ({ root, v2, admin, adminInternal }) => {
        root.get("/custom-health", (_req, res) => res.end());

        v2.use(authGuard);
        v2.use(ignoreError);
        v2.route("/items").get(listItems).post(createItem);
        v2.all("/wildcard", listItems);

        const sub = express.Router();
        sub.get("/nested", nestedHandler);
        v2.use("/sub", sub);

        admin.post("/admin/ops/reload", authGuard, listItems);
        adminInternal?.get("/admin/internal-status", listItems);
      },
    );

    const { describeRoutes } = buildRouteRegistry([
      {
        owner: "core",
        isCore: true,
        routes: ({ v2 }) => {
          v2.post("/scrape", coreScrape);
        },
      },
      {
        owner: "ext",
        routes: registrar,
      },
    ]);

    expect(registrar).not.toHaveBeenCalled();

    const first = describeRoutes();
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(first).toEqual([
      {
        owner: "ext",
        router: "root",
        method: "GET",
        path: "/custom-health",
        middleware: ["<anonymous>"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/items",
        middleware: ["authGuard", "listItems"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "POST",
        path: "/v2/items",
        middleware: ["authGuard", "createItem"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "ALL",
        path: "/v2/wildcard",
        middleware: ["authGuard", "listItems"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/sub/nested",
        middleware: ["authGuard", "nestedHandler"],
      },
      {
        owner: "ext",
        router: "admin",
        method: "POST",
        path: "/admin/ops/reload",
        middleware: ["authGuard", "listItems"],
      },
      {
        owner: "ext",
        router: "adminInternal",
        method: "GET",
        path: "/admin/internal-status",
        middleware: ["listItems"],
      },
      {
        owner: "core",
        router: "v2",
        method: "POST",
        path: "/v2/scrape",
        middleware: ["coreScrape"],
      },
    ]);

    // Subsequent calls use the cache and return defensive copies.
    first[0].middleware.push("mutated");
    first.push({
      owner: "fake",
      router: "root",
      method: "GET",
      path: "/fake",
      middleware: [],
    });

    const second = describeRoutes();
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(second).toHaveLength(8);
    expect(second[0].middleware).toEqual(["<anonymous>"]);
  });

  it("describes sub-routers mounted on multiple path prefixes", () => {
    function ping(_req: express.Request, res: express.Response) {
      res.end();
    }
    const { describeRoutes } = buildRouteRegistry([
      {
        owner: "ext",
        routes: ({ v2 }) => {
          const sub = express.Router();
          sub.get("/ping", ping);
          v2.use(["/a", "/b"], sub);
        },
      },
    ]);

    expect(describeRoutes()).toEqual([
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/a/ping",
        middleware: ["ping"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/b/ping",
        middleware: ["ping"],
      },
    ]);
  });

  it("returns an empty array without error when no extension registers routes", () => {
    const { describeRoutes } = buildRouteRegistry([
      { owner: "core", isCore: true },
    ]);

    expect(describeRoutes()).toEqual([]);
  });

  it("validates route registrars and router bags", () => {
    expect(() =>
      buildRouteRegistry([
        { owner: "bad", routes: "not-a-fn" as unknown as RouteRegistrar },
      ]),
    ).toThrow('Extension "bad" routes must be a function');

    const { mountRoutes } = buildRouteRegistry([
      { owner: "core", isCore: true },
    ]);

    expect(() => mountRoutes(null as unknown as Routers)).toThrow(
      "Routers must be an object",
    );
    expect(() =>
      mountRoutes({
        root: null as unknown as express.Router,
        v2: express.Router(),
        admin: express.Router(),
      }),
    ).toThrow("Routers.root must be an Express router");
    expect(() =>
      mountRoutes({
        root: express.Router(),
        v2: express.Router(),
        admin: express.Router(),
        adminInternal: null as unknown as express.Router,
      }),
    ).toThrow("Routers.adminInternal must be an Express router");
  });
});
