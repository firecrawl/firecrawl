/*
 * Express route registration and introspection for extensions.
 *
 * Non-core extensions mount before core's routes so a contributed route can
 * answer first or call `next()`. This file imports only Express types at top
 * level; `express` is loaded lazily only when `describeRoutes()` introspects
 * at least one registered route function.
 */
import type { Router } from "express";

/** The Express router slots exposed to extensions. */
export type RouterName = "root" | "v2" | "admin" | "adminInternal";

/** Express routers passed to `Extension.routes` and `service.mountRoutes`. */
export interface Routers {
  /** The Express app root (`/`). Contributed routes mount before core's. */
  root: Router;
  /** The `/v2` router. Contributed routes mount before core's. */
  v2: Router;
  /** The admin router mounted on the main API listener. Contributed routes mount before core's. */
  admin: Router;
  /** Optional internal-only admin router served on `ADMIN_INTERNAL_PORT`. */
  adminInternal?: Router;
}

/** Callback an extension supplies to mount its routes on the service's routers. */
export type RouteRegistrar = (routers: Routers) => void;

/** Description of a route registered by an extension in `ServiceDescription`. */
export interface DescribedRoute {
  /** Extension that registered this route. */
  owner: string;
  /** Router slot the route was registered on. */
  router: RouterName;
  /** Uppercase HTTP method (for example "GET", "POST", or "ALL"). */
  method: string;
  /** Mounted path including the router slot prefix (for example "/v2/status"). */
  path: string;
  /** Middleware and handler function names in execution order. */
  middleware: string[];
}

/** @internal */
export interface RouteRegistrySource {
  owner: string;
  isCore?: boolean;
  routes?: RouteRegistrar;
}

interface InternalExpressLayer {
  name?: string;
  handle?: ((...args: unknown[]) => unknown) & {
    stack?: InternalExpressLayer[];
  };
  route?: {
    path: string | RegExp | Array<string | RegExp>;
    methods: Record<string, boolean>;
    stack: Array<{
      name?: string;
      method?: string;
      handle?: (...args: unknown[]) => unknown;
    }>;
  } | null;
}

const routerBasePaths: ReadonlyArray<readonly [RouterName, string]> = [
  ["root", ""],
  ["v2", "/v2"],
  ["admin", ""],
  ["adminInternal", ""],
];

function isRouterLike(value: unknown): boolean {
  return (
    value !== null && (typeof value === "object" || typeof value === "function")
  );
}

function validateRouters(routers: Routers): void {
  if (typeof routers !== "object" || routers === null) {
    throw new Error("Routers must be an object");
  }
  for (const key of ["root", "v2", "admin"] as const) {
    if (!isRouterLike(routers[key])) {
      throw new Error(`Routers.${key} must be an Express router`);
    }
  }
  if (
    routers.adminInternal !== undefined &&
    !isRouterLike(routers.adminInternal)
  ) {
    throw new Error("Routers.adminInternal must be an Express router");
  }
}

function joinRoutePaths(base: string, segment: string | RegExp): string {
  if (segment instanceof RegExp) {
    const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    return trimmedBase ? `${trimmedBase}/${String(segment)}` : String(segment);
  }
  if (segment === "" || segment === "/") {
    return base || "/";
  }
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedSegment = segment.startsWith("/") ? segment : `/${segment}`;
  return `${trimmedBase}${normalizedSegment}`;
}

function prefixApplies(mountPath: string, fullPath: string): boolean {
  if (mountPath === "" || mountPath === "/") return true;
  const normalizedMount = mountPath.endsWith("/")
    ? mountPath.slice(0, -1)
    : mountPath;
  return (
    fullPath === normalizedMount || fullPath.startsWith(`${normalizedMount}/`)
  );
}

function handlerName(
  fn: ((...args: unknown[]) => unknown) | undefined,
  fallback?: string,
): string {
  if (fn && fn.name) return fn.name;
  if (fallback && fallback.length > 0) return fallback;
  return "<anonymous>";
}

function createProbeRouter(
  expressModule: typeof import("express"),
  mountPaths: WeakMap<object, string>,
): Router {
  const router = expressModule.Router();
  const originalUse = router.use.bind(router) as (...args: unknown[]) => Router;

  router.use = function wrappedUse(...args: unknown[]): Router {
    const stack = router.stack as unknown as InternalExpressLayer[] | undefined;
    const before = stack ? stack.length : 0;
    const first = args[0];
    let mountPath = "";
    if (typeof first === "string") {
      mountPath = first;
    } else if (first instanceof RegExp) {
      mountPath = String(first);
    } else if (Array.isArray(first) && typeof first[0] === "string") {
      mountPath = first[0];
    }

    const result = originalUse(...args);
    const updatedStack = router.stack as unknown as
      | InternalExpressLayer[]
      | undefined;
    if (updatedStack) {
      for (let i = before; i < updatedStack.length; i++) {
        mountPaths.set(updatedStack[i], mountPath);
      }
    }
    return result;
  } as typeof router.use;

  return router;
}

function collectRoutesFromStack(
  stack: readonly InternalExpressLayer[],
  owner: string,
  routerName: RouterName,
  basePath: string,
  inheritedMiddleware: readonly string[],
  mountPaths: WeakMap<object, string>,
  out: DescribedRoute[],
): void {
  const scopedMiddleware: Array<{ mountPath: string; name: string }> = [];

  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const allMethodKeys = Object.keys(route.methods).filter(
        key => route.methods[key],
      );
      const specificMethods = allMethodKeys.filter(key => key !== "_all");
      const methodsToEmit =
        specificMethods.length > 0
          ? specificMethods
          : allMethodKeys.includes("_all")
            ? ["_all"]
            : [];

      for (const rawPath of paths) {
        const fullPath = joinRoutePaths(basePath, rawPath);
        const matchingScoped = scopedMiddleware
          .filter(entry => prefixApplies(entry.mountPath, fullPath))
          .map(entry => entry.name);

        for (const method of methodsToEmit) {
          const routeHandlers = route.stack
            .filter(
              step =>
                step.method === undefined ||
                method === "_all" ||
                step.method === method,
            )
            .map(step => handlerName(step.handle, step.name));

          out.push({
            owner,
            router: routerName,
            method: method === "_all" ? "ALL" : method.toUpperCase(),
            path: fullPath,
            middleware: [
              ...inheritedMiddleware,
              ...matchingScoped,
              ...routeHandlers,
            ],
          });
        }
      }
      continue;
    }

    const mountSegment = mountPaths.get(layer) ?? "";
    const layerMountPath = joinRoutePaths(basePath, mountSegment);

    if (
      typeof layer.handle === "function" &&
      Array.isArray(layer.handle.stack)
    ) {
      const matchingScoped = scopedMiddleware
        .filter(entry => prefixApplies(entry.mountPath, layerMountPath))
        .map(entry => entry.name);
      collectRoutesFromStack(
        layer.handle.stack,
        owner,
        routerName,
        layerMountPath,
        [...inheritedMiddleware, ...matchingScoped],
        mountPaths,
        out,
      );
      continue;
    }

    if (typeof layer.handle === "function" && layer.handle.length !== 4) {
      scopedMiddleware.push({
        mountPath: layerMountPath,
        name: handlerName(layer.handle, layer.name),
      });
    }
  }
}

/**
 * Validates extension route registrars and returns `mountRoutes` and lazy
 * `describeRoutes`. Non-core extensions mount first in list order; core mounts
 * last so contributed routes can answer first or call `next()`.
 *
 * @internal
 */
export function buildRouteRegistry(sources: readonly RouteRegistrySource[]): {
  mountRoutes(routers: Routers): void;
  describeRoutes(): DescribedRoute[];
} {
  const nonCore: Array<{ owner: string; register: RouteRegistrar }> = [];
  let coreEntry: { owner: string; register: RouteRegistrar } | undefined;

  for (const source of sources) {
    if (source.routes === undefined) continue;
    if (typeof source.routes !== "function") {
      throw new Error(`Extension "${source.owner}" routes must be a function`);
    }
    const entry = { owner: source.owner, register: source.routes };
    if (source.isCore) {
      coreEntry = entry;
    } else {
      nonCore.push(entry);
    }
  }

  const ordered = coreEntry ? [...nonCore, coreEntry] : nonCore;
  let cachedDescription: DescribedRoute[] | undefined;

  const describeRoutes = (): DescribedRoute[] => {
    if (ordered.length === 0) return [];
    if (cachedDescription) return structuredClone(cachedDescription);

    const expressModule = require("express") as typeof import("express");
    const collected: DescribedRoute[] = [];

    for (const entry of ordered) {
      const mountPaths = new WeakMap<object, string>();
      const probeRouters: Record<RouterName, Router> = {
        root: createProbeRouter(expressModule, mountPaths),
        v2: createProbeRouter(expressModule, mountPaths),
        admin: createProbeRouter(expressModule, mountPaths),
        adminInternal: createProbeRouter(expressModule, mountPaths),
      };

      entry.register(probeRouters);

      for (const [routerName, basePath] of routerBasePaths) {
        const stack = probeRouters[routerName].stack as unknown as
          | InternalExpressLayer[]
          | undefined;
        if (!stack || stack.length === 0) continue;
        collectRoutesFromStack(
          stack,
          entry.owner,
          routerName,
          basePath,
          [],
          mountPaths,
          collected,
        );
      }
    }

    cachedDescription = collected;
    return structuredClone(collected);
  };

  return {
    mountRoutes(routers: Routers): void {
      validateRouters(routers);
      for (const entry of ordered) {
        entry.register(routers);
      }
    },
    describeRoutes,
  };
}
