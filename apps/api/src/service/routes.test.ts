import Module from "node:module";
import type express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRouteRegistry,
  type RouteRegistrar,
  type Routers,
} from "./routes";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildRouteRegistry", () => {
  it("does not load express when no extension registers routes", async () => {
    const requireSpy = vi.spyOn(Module.prototype, "require");
    vi.resetModules();
    const { buildRouteRegistry: freshBuildRouteRegistry } = await import(
      "./routes.js"
    );

    const { describeRoutes } = freshBuildRouteRegistry([
      { owner: "core", isCore: true },
    ]);

    expect(describeRoutes()).toEqual([]);
    expect(requireSpy).not.toHaveBeenCalledWith("express");
  });

  it("mounts non-core extension routes before core routes so extensions can shadow or call next()", async () => {
    const { default: expressRuntime } = await import("express");
    const order: string[] = [];

    const { mountRoutes, describeRoutes } = buildRouteRegistry([
      {
        owner: "core",
        isCore: true,
        routes: ({ root, v2, admin }) => {
          order.push("core");
          root.get("/status", function coreStatus(_req, res) {
            res.json({ from: "core-root" });
          });
          v2.get("/shadowed", function coreShadowed(_req, res) {
            res.json({ from: "core-v2" });
          });
          v2.get("/fallthrough", function coreFallthrough(_req, res) {
            res.json({ from: "core-fallthrough", seen: res.locals.seen });
          });
          admin.get("/admin/check", function coreAdminCheck(_req, res) {
            res.json({ from: "core-admin" });
          });
        },
      },
      {
        owner: "first",
        routes: ({ v2, adminInternal }) => {
          order.push("first");
          v2.get("/shadowed", function firstShadowed(_req, res) {
            res.json({ from: "first" });
          });
          v2.get("/fallthrough", function firstFallthrough(_req, res, next) {
            res.locals.seen = ["first"];
            next();
          });
          adminInternal?.get(
            "/admin/internal-ping",
            function internalPing(_req, res) {
              res.json({ ok: true });
            },
          );
        },
      },
      {
        owner: "second",
        routes: ({ v2 }) => {
          order.push("second");
          v2.get("/fallthrough", function secondFallthrough(_req, res, next) {
            res.locals.seen = [...(res.locals.seen ?? []), "second"];
            next();
          });
          v2.get("/only-second", function onlySecond(_req, res) {
            res.json({ from: "second" });
          });
        },
      },
    ]);

    const app = expressRuntime();
    const v2 = expressRuntime.Router();
    const admin = expressRuntime.Router();
    const adminInternal = expressRuntime.Router();

    mountRoutes({ root: app, v2, admin, adminInternal });
    app.use("/v2", v2);
    app.use(admin);

    const internalApp = expressRuntime();
    internalApp.use(adminInternal);

    expect(order).toEqual(["first", "second", "core"]);

    // describeRoutes reuses metadata captured during mountRoutes without re-running registrars.
    const described = describeRoutes();
    expect(order).toEqual(["first", "second", "core"]);
    expect(described.map(r => `${r.owner}:${r.method}:${r.path}`)).toEqual([
      "first:GET:/v2/shadowed",
      "first:GET:/v2/fallthrough",
      "first:GET:/admin/internal-ping",
      "second:GET:/v2/fallthrough",
      "second:GET:/v2/only-second",
      "core:GET:/status",
      "core:GET:/v2/shadowed",
      "core:GET:/v2/fallthrough",
      "core:GET:/admin/check",
    ]);

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

  it("works when core has no routes and only extensions register routes", async () => {
    const { default: expressRuntime } = await import("express");
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
      root: expressRuntime.Router(),
      v2: expressRuntime.Router(),
      admin: expressRuntime.Router(),
    });

    expect(order).toEqual(["ext-a", "ext-b"]);
  });

  it("describes routes in mount order including deeply nested routers, array prefixes, and regex middleware scopes", async () => {
    const { default: expressRuntime } = await import("express");
    function authGuard(
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) {
      next();
    }
    function teamRegexGuard(
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) {
      next();
    }
    function outerGuard(
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
    function deepLeaf(_req: express.Request, res: express.Response) {
      res.end();
    }
    function teamUsage(_req: express.Request, res: express.Response) {
      res.end();
    }
    function multiPing(_req: express.Request, res: express.Response) {
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
        v2.use(/^\/team/, teamRegexGuard);
        v2.route("/items").get(listItems).post(createItem);
        v2.get("/team/usage", teamUsage);
        v2.all("/wildcard", listItems);

        const outer = expressRuntime.Router();
        outer.use(outerGuard);
        const inner = expressRuntime.Router();
        inner.get("/leaf", deepLeaf);
        outer.use("/inner", inner);
        v2.use("/outer", outer);

        const multi = expressRuntime.Router();
        multi.get("/ping", multiPing);
        v2.use(["/a", "/b"], multi);

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
        method: "GET",
        path: "/v2/team/usage",
        middleware: ["authGuard", "teamRegexGuard", "teamUsage"],
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
        path: "/v2/outer/inner/leaf",
        middleware: ["authGuard", "outerGuard", "deepLeaf"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/a/ping",
        middleware: ["authGuard", "multiPing"],
      },
      {
        owner: "ext",
        router: "v2",
        method: "GET",
        path: "/v2/b/ping",
        middleware: ["authGuard", "multiPing"],
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
    expect(second).toHaveLength(11);
    expect(second[0].middleware).toEqual(["<anonymous>"]);
  });

  it("validates route registrars and router bags", async () => {
    const { default: expressRuntime } = await import("express");
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
        v2: expressRuntime.Router(),
        admin: expressRuntime.Router(),
      }),
    ).toThrow("Routers.root must be an Express router");
    expect(() =>
      mountRoutes({
        root: expressRuntime.Router(),
        v2: expressRuntime.Router(),
        admin: expressRuntime.Router(),
        adminInternal: null as unknown as express.Router,
      }),
    ).toThrow("Routers.adminInternal must be an Express router");
  });
});
