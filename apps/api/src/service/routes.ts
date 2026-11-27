/*
 * Express route registration and introspection for extensions.
 *
 * Non-core extensions mount before core's routes so a contributed route can
 * answer first or call `next()`. This file imports only Express types at top
 * level; `express` is loaded lazily only when `describeRoutes()` introspects
 * at least one registered route function without a prior live mount.
 */
import type { Router } from "express";

/** The Express router slots exposed to extensions. */
export type RouterName = "rootRaw" | "root" | "v2" | "admin" | "adminInternal";

/** Express routers passed to `Extension.routes` and `service.mountRoutes`. */
export interface Routers {
  /**
   * Optional pre-body-parser Express app root (`/`), mounted before the global
   * body parsers and catch-all CORS middleware for streaming or custom-parsed
   * routes.
   */
  rootRaw?: Router;
  /** The Express app root (`/`). Contributed routes mount before core's. */
  root: Router;
  /** The `/v2` router. Contributed routes mount before core's. */
  v2: Router;
  /** The admin router mounted on the main API listener. Contributed routes mount before core's. */
  admin: Router;
  /** Optional internal-only admin router served on `ADMIN_INTERNAL_PORT`. */
  adminInternal?: Router;
}

/**
 * Callback an extension supplies to mount its routes on the service's routers.
 *
 * Registrars must be side-effect-free route wiring: `service.describe().routes`
 * may invoke them on probe routers when no HTTP server has mounted routes yet.
 */
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
  middleware: Array<string>;
}

/** @internal */
export interface RouteRegistrySource {
  owner: string;
  isCore?: boolean;
  routes?: RouteRegistrar;
}

type ExpressMatcherResult = boolean | object | null | undefined;
type ExpressHandlerFn = (...args: Array<never>) => void;

interface InternalExpressLayer {
  name?: string;
  slash?: boolean;
  matchers?: ReadonlyArray<(path: string) => ExpressMatcherResult>;
  regexp?: RegExp;
  handle?: ExpressHandlerFn & {
    stack?: Array<InternalExpressLayer>;
  };
  route?: {
    path: string | RegExp | Array<string | RegExp>;
    methods: Record<string, boolean>;
    stack: Array<{
      name?: string;
      method?: string;
      handle?: ExpressHandlerFn;
    }>;
  } | null;
}

interface ExpressModuleLike {
  Router: {
    (): Router;
    prototype: {
      use: (...args: Array<unknown>) => Router;
    };
  };
}

function isExpressModuleLike(value: unknown): value is ExpressModuleLike {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    !("Router" in value) ||
    typeof value.Router !== "function"
  ) {
    return false;
  }
  const proto: unknown = value.Router.prototype;
  return (
    (typeof proto === "object" || typeof proto === "function") &&
    proto !== null &&
    "use" in proto &&
    typeof proto.use === "function"
  );
}

function requireExpressModule(): ExpressModuleLike {
  const loaded: unknown = require("express");
  if (!isExpressModuleLike(loaded)) {
    throw new Error("express module failed to export Router");
  }
  return loaded;
}

function isInternalExpressLayer(value: unknown): value is InternalExpressLayer {
  return typeof value === "object" && value !== null;
}

function isInternalExpressLayerArray(
  value: unknown,
): value is Array<InternalExpressLayer> {
  return Array.isArray(value) && value.every(isInternalExpressLayer);
}

type MountMatcher =
  | { kind: "string"; path: string }
  | { kind: "regex"; regex: RegExp; display: string };

interface ScopedMiddleware {
  layer: InternalExpressLayer;
  mountMatchers: ReadonlyArray<MountMatcher> | undefined;
  depth: number;
  name: string;
}

const routerBasePaths: ReadonlyArray<readonly [RouterName, string]> = [
  ["rootRaw", ""],
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

function getRouterStack(
  router: unknown,
): Array<InternalExpressLayer> | undefined {
  if (!isRouterLike(router)) {
    return undefined;
  }
  if (
    (typeof router === "object" || typeof router === "function") &&
    router !== null
  ) {
    if ("stack" in router && isInternalExpressLayerArray(router.stack)) {
      return router.stack;
    }
    if (
      "router" in router &&
      (typeof router.router === "object" ||
        typeof router.router === "function") &&
      router.router !== null &&
      "stack" in router.router &&
      isInternalExpressLayerArray(router.router.stack)
    ) {
      return router.router.stack;
    }
  }
  return undefined;
}

function hasExpressStacks(routers: Routers): boolean {
  return (
    (routers.rootRaw === undefined ||
      getRouterStack(routers.rootRaw) !== undefined) &&
    getRouterStack(routers.root) !== undefined &&
    getRouterStack(routers.v2) !== undefined &&
    getRouterStack(routers.admin) !== undefined &&
    (routers.adminInternal === undefined ||
      getRouterStack(routers.adminInternal) !== undefined)
  );
}

function validateRouters(routers: Routers): void {
  if (typeof routers !== "object" || routers === null) {
    throw new Error("Routers must be an object");
  }
  if (routers.rootRaw !== undefined && !isRouterLike(routers.rootRaw)) {
    throw new Error("Routers.rootRaw must be an Express router");
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

function joinMatcher(base: string, matcher: MountMatcher): string {
  return matcher.kind === "regex"
    ? joinRoutePaths(base, matcher.regex)
    : joinRoutePaths(base, matcher.path);
}

function prefixApplies(mountPath: string, fullPath: string): boolean {
  if (mountPath === "" || mountPath === "/") {
    return true;
  }
  const normalizedMount = mountPath.endsWith("/")
    ? mountPath.slice(0, -1)
    : mountPath;
  return (
    fullPath === normalizedMount || fullPath.startsWith(`${normalizedMount}/`)
  );
}

function testStatelessRegex(regex: RegExp, input: string): boolean {
  if (!regex.global && !regex.sticky) {
    return regex.test(input);
  }
  const stateless = new RegExp(
    regex.source,
    regex.flags.replaceAll(/[gy]/g, ""),
  );
  return stateless.test(input);
}

function middlewareApplies(
  entry: ScopedMiddleware,
  ancestors: ReadonlyArray<MountMatcher>,
  rawPath: string | RegExp,
): boolean {
  const { layer, mountMatchers } = entry;
  if (layer.slash) {
    return true;
  }

  let candidatePath = "";
  for (let i = entry.depth; i < ancestors.length; i++) {
    candidatePath = joinMatcher(candidatePath, ancestors[i]);
  }
  candidatePath = joinRoutePaths(candidatePath, rawPath);

  if (layer.matchers !== undefined) {
    const alignedMountMatchers =
      mountMatchers && mountMatchers.length === layer.matchers.length
        ? mountMatchers
        : undefined;

    return layer.matchers.some((matcher, index) => {
      const recorded = alignedMountMatchers?.[index];
      if (recorded?.kind === "regex") {
        return testStatelessRegex(recorded.regex, candidatePath);
      }
      try {
        return Boolean(matcher(candidatePath));
      } catch {
        return false;
      }
    });
  }

  if (layer.regexp instanceof RegExp) {
    return testStatelessRegex(layer.regexp, candidatePath);
  }

  if (!mountMatchers) {
    return true;
  }
  return mountMatchers.some(matcher => {
    if (matcher.kind === "regex") {
      return testStatelessRegex(matcher.regex, candidatePath);
    }
    return prefixApplies(matcher.path, candidatePath);
  });
}

function handlerName(
  fn: ExpressHandlerFn | undefined,
  fallback?: string,
): string {
  if (fn && fn.name) {
    return fn.name;
  }
  if (fallback && fallback.length > 0) {
    return fallback;
  }
  return "<anonymous>";
}

function parseMountMatchers(first: unknown): Array<MountMatcher> {
  if (typeof first === "string") {
    return [{ kind: "string", path: first }];
  }
  if (first instanceof RegExp) {
    return [{ kind: "regex", regex: first, display: String(first) }];
  }
  if (Array.isArray(first)) {
    const matchers: Array<MountMatcher> = [];
    for (const item of first) {
      if (typeof item === "string") {
        matchers.push({ kind: "string", path: item });
      } else if (item instanceof RegExp) {
        matchers.push({ kind: "regex", regex: item, display: String(item) });
      }
    }
    if (matchers.length > 0) {
      return matchers;
    }
  }
  return [{ kind: "string", path: "" }];
}

/**
 * Temporarily instruments `express.Router.prototype.use` so any `router.use`
 * call, including inside nested routers created by a registrar, records its
 * mount path matchers onto the newly added stack layers.
 */
function withMountTracking<T>(
  expressModule: ExpressModuleLike,
  mountPaths: WeakMap<object, Array<MountMatcher>>,
  fn: () => T,
): T {
  const routerProto = expressModule.Router.prototype;
  const originalUse = routerProto.use;
  routerProto.use = function trackedUse(
    this: { stack?: Array<InternalExpressLayer> },
    ...args: Array<unknown>
  ) {
    const before = Array.isArray(this.stack) ? this.stack.length : 0;
    const matchers = parseMountMatchers(args[0]);
    const result = originalUse.apply(this, args);
    if (Array.isArray(this.stack)) {
      for (let i = before; i < this.stack.length; i++) {
        mountPaths.set(this.stack[i], matchers);
      }
    }
    return result;
  };
  try {
    return fn();
  } finally {
    routerProto.use = originalUse;
  }
}

function collectRoutesFromStack(
  stack: ReadonlyArray<InternalExpressLayer>,
  owner: string,
  routerName: RouterName,
  basePath: string,
  ancestors: ReadonlyArray<MountMatcher>,
  inheritedMiddleware: ReadonlyArray<ScopedMiddleware>,
  mountPaths: WeakMap<object, Array<MountMatcher>>,
  out: Array<DescribedRoute>,
): void {
  const scopedMiddleware: Array<ScopedMiddleware> = [...inheritedMiddleware];

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
        const matchingScoped: Array<string> = [];
        for (const entry of scopedMiddleware) {
          if (middlewareApplies(entry, ancestors, rawPath)) {
            matchingScoped.push(entry.name);
          }
        }

        for (const method of methodsToEmit) {
          const routeHandlers: Array<string> = [];
          for (const step of route.stack) {
            if (
              step.method === undefined ||
              method === "_all" ||
              step.method === method
            ) {
              routeHandlers.push(handlerName(step.handle, step.name));
            }
          }

          out.push({
            owner,
            router: routerName,
            method: method === "_all" ? "ALL" : method.toUpperCase(),
            path: fullPath,
            middleware: [...matchingScoped, ...routeHandlers],
          });
        }
      }
      continue;
    }

    const recordedMountMatchers = mountPaths.get(layer);
    const mountMatchers = recordedMountMatchers ?? [
      { kind: "string" as const, path: "" },
    ];

    if (
      typeof layer.handle === "function" &&
      Array.isArray(layer.handle.stack)
    ) {
      for (const matcher of mountMatchers) {
        const layerMountPath = joinMatcher(basePath, matcher);
        collectRoutesFromStack(
          layer.handle.stack,
          owner,
          routerName,
          layerMountPath,
          [...ancestors, matcher],
          scopedMiddleware,
          mountPaths,
          out,
        );
      }
      continue;
    }

    if (typeof layer.handle === "function" && layer.handle.length !== 4) {
      scopedMiddleware.push({
        layer,
        mountMatchers: recordedMountMatchers,
        depth: ancestors.length,
        name: handlerName(layer.handle, layer.name),
      });
    }
  }
}

interface BuiltRouteRegistry {
  mountRoutes(routers: Routers): void;
  describeRoutes(): Array<DescribedRoute>;
}

/**
 * Validates extension route registrars and returns `mountRoutes` and lazy
 * `describeRoutes`. Non-core extensions mount first in list order; core mounts
 * last so contributed routes can answer first or call `next()`.
 *
 * @internal
 */
export function buildRouteRegistry(
  sources: ReadonlyArray<RouteRegistrySource>,
): BuiltRouteRegistry {
  const nonCore: Array<{ owner: string; register: RouteRegistrar }> = [];
  let coreEntry: { owner: string; register: RouteRegistrar } | undefined;

  for (const source of sources) {
    if (source.routes === undefined) {
      continue;
    }
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
  let cachedDescription: Array<DescribedRoute> | undefined;

  const describeRoutes = (): Array<DescribedRoute> => {
    if (ordered.length === 0) {
      return [];
    }
    if (cachedDescription) {
      return structuredClone(cachedDescription);
    }

    const expressModule = requireExpressModule();
    const collected: Array<DescribedRoute> = [];
    const mountPaths = new WeakMap<object, Array<MountMatcher>>();

    for (const entry of ordered) {
      const probeRouters: Record<RouterName, Router> = {
        rootRaw: expressModule.Router(),
        root: expressModule.Router(),
        v2: expressModule.Router(),
        admin: expressModule.Router(),
        adminInternal: expressModule.Router(),
      };

      withMountTracking(expressModule, mountPaths, () => {
        entry.register(probeRouters);
      });

      for (const [routerName, basePath] of routerBasePaths) {
        const stack = getRouterStack(probeRouters[routerName]);
        if (!stack || stack.length === 0) {
          continue;
        }
        collectRoutesFromStack(
          stack,
          entry.owner,
          routerName,
          basePath,
          [],
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
      if (ordered.length === 0) {
        return;
      }

      if (!hasExpressStacks(routers)) {
        for (const entry of ordered) {
          entry.register(routers);
        }
        return;
      }

      // Collect route metadata during the live mount so a later `describe()`
      // does not execute registrars a second time or diverge from mounted routes.
      const expressModule = requireExpressModule();
      const mountPaths = new WeakMap<object, Array<MountMatcher>>();
      const collected: Array<DescribedRoute> = [];

      for (const entry of ordered) {
        const startOffsets = new Map<RouterName, number>();
        for (const [routerName] of routerBasePaths) {
          const stack = getRouterStack(routers[routerName]);
          if (stack) {
            startOffsets.set(routerName, stack.length);
          }
        }

        withMountTracking(expressModule, mountPaths, () => {
          entry.register(routers);
        });

        for (const [routerName, basePath] of routerBasePaths) {
          const stack = getRouterStack(routers[routerName]);
          const offset = startOffsets.get(routerName);
          if (!stack || offset === undefined || stack.length <= offset) {
            continue;
          }
          collectRoutesFromStack(
            stack.slice(offset),
            entry.owner,
            routerName,
            basePath,
            [],
            [],
            mountPaths,
            collected,
          );
        }
      }

      cachedDescription = collected;
    },
    describeRoutes,
  };
}
