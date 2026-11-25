/*
 * The service: what one deployment of the API is made of, built once from a
 * config and read by the rest of the code.
 */
import type { TransportableErrorClass } from "../lib/error";
import { defaultModules } from "./defaults";
import {
  buildEngineRegistry,
  type DescribedEngineFeature,
  type Engine,
  type EngineFeatureMap,
  type EngineRegistry,
} from "./engines";
import { assertEnv, describeEnv } from "./env";
import { buildHookRegistry, type HookHandlers, type Hooks } from "./hooks";
import {
  buildLlmProviderRegistry,
  type LlmProvider,
  type LlmProviderRegistry,
} from "./llm-providers";
import { freezeModules, type Modules } from "./modules";
import type {
  BaseCaller,
  BaseRequestContext,
  Caller,
  RequestContext,
} from "./request-context";
import {
  buildRequestSchemaRegistry,
  type DescribedRequestSchemas,
  type RequestContributions,
  type RequestSchemaBuilder,
  type RequestSchemas,
} from "./request";
import {
  buildRouteRegistry,
  type DescribedRoute,
  type RouteRegistrar,
  type RouterName,
  type Routers,
} from "./routes";
import {
  buildSearchProviderRegistry,
  type DescribedSearchProvider,
  type SearchProvider,
  type SearchProviderRegistry,
} from "./search-providers";
import {
  buildWorkerRegistry,
  type RoleRegistry,
  type Worker,
  type WorkerRunEnv,
} from "./workers";

export type { Modules } from "./modules";
export type {
  DescribedRoute,
  RouteRegistrar,
  RouterName,
  Routers,
} from "./routes";
export type { RoleRegistry, Worker, WorkerRunEnv } from "./workers";

/**
 * A named bundle of everything that can be added to a service without the
 * service calling it by name. The service's own parts are one too, named
 * "core".
 */
export interface Extension {
  /** The owner of everything listed here, as `describe()` shows it. */
  name: string;
  hooks?: HookHandlers;
  /**
   * Error classes that can cross the job queue. A function is called the first
   * time the service looks an error up, so that listing classes does not load
   * them when the service is built.
   */
  errors?: TransportableErrorClass[] | (() => TransportableErrorClass[]);
  /**
   * Scrape engines contributed by this extension. A later engine of the same
   * name replaces an earlier one.
   */
  engines?: readonly Engine[];
  /**
   * Scrape engine feature priorities contributed by this extension. A later
   * definition of the same feature name replaces an earlier one.
   */
  engineFeatures?: EngineFeatureMap;
  /**
   * Search providers contributed by this extension. A later provider of the
   * same name replaces an earlier one.
   */
  searchProviders?: readonly SearchProvider[];
  /**
   * LLM providers contributed by this extension. A later provider of the same
   * name replaces an earlier one.
   */
  llmProviders?: readonly LlmProvider[];
  /**
   * Request-schema fields, formats, and cross-field scrape-option rules
   * contributed by this extension.
   */
  request?: RequestContributions;
  /**
   * Express routes contributed by this extension. Non-core extensions mount
   * before core's routes so a contributed route can answer first or call
   * `next()`.
   */
  routes?: RouteRegistrar;
  /** Process roles, by name. A later extension replaces a role of the same name. */
  workers?: Record<string, Worker>;
}

type RequiredAuthSlot = BaseCaller extends Caller ? never : "auth";
type RequiredPolicySlot = BaseRequestContext extends RequestContext
  ? never
  : "policy";
type RequiredModuleSlots = RequiredAuthSlot | RequiredPolicySlot;

/**
 * Module slot configuration. When `Caller` is widened with required fields,
 * `auth` must be supplied explicitly instead of falling back to `openAuth()`.
 * When `RequestContext` is widened with required fields, `policy` must be
 * supplied explicitly instead of falling back to `unrestrictedPolicy()`.
 */
export type ModulesConfig = [RequiredModuleSlots] extends [never]
  ? Partial<Modules>
  : Partial<Omit<Modules, RequiredModuleSlots>> &
      Pick<Modules, RequiredModuleSlots>;

/** The whole config. Everything that is not a slot belongs to a named extension. */
export type ServiceConfig = ([RequiredModuleSlots] extends [never]
  ? {
      /** Module slots to override; omitted slots use the built-in defaults. */
      modules?: ModulesConfig;
    }
  : {
      /** Module slots; required slots must be supplied when `Caller` or `RequestContext` is widened. */
      modules: ModulesConfig;
    }) & {
  /** Applied in list order, after the service's own extension. */
  extensions?: Extension[];
};

export interface CoreParts {
  /** The service's own extension, applied first. */
  core: Extension;
  /** Where the service reports a failure it does not pass on to a caller. */
  logger: { error(message: string, meta: Record<string, unknown>): void };
  /** Builds compiled request schemas lazily on first `service.schemas` access. */
  buildRequestSchemas?: RequestSchemaBuilder;
}

/** What a service is made of, as plain data that can be compared between builds. */
export interface ServiceDescription {
  /** Extension names, in the order they apply. */
  extensions: string[];
  /** The slots that have an implementation. */
  modules: string[];
  /** For each hook point with a handler, the owner of each handler, in the order they run. */
  hooks: Record<string, string[]>;
  /** For each error code with a class, the extension the class comes from. */
  errors: Record<string, string>;
  /** For each registered scrape engine, the extension it comes from. */
  engines: Record<string, string>;
  /** For each registered scrape engine feature, its owner and scoring priority. */
  engineFeatures: Record<string, DescribedEngineFeature>;
  /** For each registered search provider, its owner and priority. */
  searchProviders: Record<string, DescribedSearchProvider>;
  /** For each registered LLM provider, the extension it comes from. */
  llmProviders: Record<string, string>;
  /** Contributed request fields, formats, and rules, by owner. */
  request: DescribedRequestSchemas;
  /** Express routes registered by extensions, in mount order. */
  routes: DescribedRoute[];
  /** For each process role, the extension it comes from. */
  roles: Record<string, string>;
  /**
   * For each owner of environment variables, the variables it declares. The
   * owners are those defined in this process so far, whichever service asks.
   */
  env: Record<string, string[]>;
}

/** The error classes of a service, by the code each carries across the job queue. */
export interface ErrorRegistry {
  /** The class registered under a code, or undefined when the service has none. */
  classFor(code: string): TransportableErrorClass | undefined;
}

export interface Service {
  readonly modules: Readonly<Modules>;
  readonly hooks: Hooks;
  readonly errors: ErrorRegistry;
  readonly engines: EngineRegistry;
  readonly searchProviders: SearchProviderRegistry;
  readonly llmProviders: LlmProviderRegistry;
  readonly schemas: RequestSchemas;
  readonly roles: RoleRegistry;
  readonly workers: Readonly<Record<string, Worker>>;
  /** Mounts every extension's Express routes onto `routers` in mount order. */
  mountRoutes(routers: Routers): void;
  /** What the service was made of when it was created, plus declared env owners. Each call returns a copy. */
  describe(): ServiceDescription;
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

export function createService(
  config: ServiceConfig,
  parts: CoreParts,
): Service {
  const extensions = [parts.core, ...(config.extensions ?? [])];
  const names = extensions.map(extension => extension.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new Error(`Two extensions are named "${duplicate}"`);
  }

  if (config.modules !== undefined) {
    if (typeof config.modules !== "object" || config.modules === null) {
      throw new Error("Invalid modules config");
    }
    for (const key of Object.keys(config.modules)) {
      if (
        key !== "auth" &&
        key !== "billing" &&
        key !== "blocklist" &&
        key !== "limits" &&
        key !== "messages" &&
        key !== "policy" &&
        key !== "uploads" &&
        key !== "jobStore" &&
        key !== "idempotency" &&
        key !== "webhooks"
      ) {
        throw new Error(`Unknown module slot "${key}"`);
      }
    }
  }

  const defaults = defaultModules();
  const modules = freezeModules({
    auth:
      config.modules?.auth === undefined
        ? (defaults.auth as Modules["auth"])
        : config.modules.auth,
    billing:
      config.modules?.billing === undefined
        ? defaults.billing
        : config.modules.billing,
    blocklist:
      config.modules?.blocklist === undefined
        ? defaults.blocklist
        : config.modules.blocklist,
    limits:
      config.modules?.limits === undefined
        ? defaults.limits
        : config.modules.limits,
    messages:
      config.modules?.messages === undefined
        ? defaults.messages
        : config.modules.messages,
    policy:
      config.modules?.policy === undefined
        ? (defaults.policy as Modules["policy"])
        : config.modules.policy,
    uploads:
      config.modules?.uploads === undefined
        ? defaults.uploads
        : config.modules.uploads,
    jobStore:
      config.modules?.jobStore === undefined
        ? defaults.jobStore
        : config.modules.jobStore,
    idempotency:
      config.modules?.idempotency === undefined
        ? defaults.idempotency
        : config.modules.idempotency,
    webhooks:
      config.modules?.webhooks === undefined
        ? defaults.webhooks
        : config.modules.webhooks,
  });
  const { roles, workers, describedRoles } = buildWorkerRegistry(
    extensions.map(extension => ({
      owner: extension.name,
      workers: extension.workers,
    })),
  );

  const { mountRoutes, describeRoutes } = buildRouteRegistry(
    extensions.map((extension, index) => ({
      owner: extension.name,
      isCore: index === 0,
      routes: extension.routes,
    })),
  );

  const { hooks, describedHooks } = buildHookRegistry(
    extensions.map(extension => ({
      owner: extension.name,
      hooks: extension.hooks,
    })),
    (hook, error) => parts.logger.error("Hook handler failed", { hook, error }),
  );

  const {
    registry: engines,
    describedEngines,
    describedFeatures,
  } = buildEngineRegistry(
    extensions.map(extension => ({
      owner: extension.name,
      engines: extension.engines,
      engineFeatures: extension.engineFeatures,
    })),
  );

  const { registry: searchProviders, describedSearchProviders } =
    buildSearchProviderRegistry(
      extensions.map(extension => ({
        owner: extension.name,
        searchProviders: extension.searchProviders,
      })),
    );

  const { registry: llmProviders, describedLlmProviders } =
    buildLlmProviderRegistry(
      extensions.map(extension => ({
        owner: extension.name,
        llmProviders: extension.llmProviders,
      })),
    );

  const { schemas, describedRequest } = buildRequestSchemaRegistry(
    extensions.map(extension => ({
      owner: extension.name,
      request: extension.request,
    })),
    parts.buildRequestSchemas,
  );

  // Snapshot extension names and error sources at creation so mutating an
  // extension later cannot change what loads or is described, while keeping
  // lazy error loaders deferred until first lookup.
  const errorSources = extensions.map(extension => ({
    owner: extension.name,
    errors:
      typeof extension.errors === "function"
        ? extension.errors
        : [...(extension.errors ?? [])],
  }));

  type RegisteredError = { owner: string; errorClass: TransportableErrorClass };
  let errorsByCode: Map<string, RegisteredError> | undefined;
  const registeredErrors = () => {
    if (errorsByCode) return errorsByCode;
    const byCode = new Map<string, RegisteredError>();
    for (const source of errorSources) {
      const listed =
        typeof source.errors === "function" ? source.errors() : source.errors;
      for (const errorClass of listed) {
        for (const code of errorClass.codes) {
          const taken = byCode.get(code);
          if (taken) {
            throw new Error(
              `Error code "${code}" is registered by "${taken.owner}" and by "${source.owner}"`,
            );
          }
          byCode.set(code, { owner: source.owner, errorClass });
        }
      }
    }
    errorsByCode = byCode;
    return byCode;
  };

  const baseDescription = {
    extensions: names,
    modules: Object.keys(modules).sort(),
    hooks: describedHooks,
    engines: describedEngines,
    engineFeatures: describedFeatures,
    searchProviders: describedSearchProviders,
    llmProviders: describedLlmProviders,
    request: describedRequest,
    roles: describedRoles,
  };

  return Object.freeze({
    modules,
    hooks,
    errors: Object.freeze({
      classFor: (code: string) => registeredErrors().get(code)?.errorClass,
    }),
    engines,
    searchProviders,
    llmProviders,
    schemas,
    roles,
    workers,
    mountRoutes,
    describe(): ServiceDescription {
      // Built from entries, so that a code is listed whatever its name is.
      const errors = Object.fromEntries(
        [...registeredErrors()].map(([code, { owner }]) => [code, owner]),
      );
      const copy = structuredClone(baseDescription);
      return {
        extensions: copy.extensions,
        modules: copy.modules,
        hooks: copy.hooks,
        errors: sortedByKey(errors),
        engines: copy.engines,
        engineFeatures: copy.engineFeatures,
        searchProviders: copy.searchProviders,
        llmProviders: copy.llmProviders,
        request: copy.request,
        routes: describeRoutes(),
        roles: copy.roles,
        env: sortedByKey(describeEnv()),
      };
    },
  });
}

let installed: Service | undefined;
let startedRole: string | undefined;
let stopRun: Promise<void> | undefined;

/** The role `run` started in this process, or undefined when it has started none. */
export function processRole(): string | undefined {
  return startedRole;
}

/** The currently installed service, or undefined when none is installed. */
export function installedService(): Service | undefined {
  return installed;
}

/**
 * Runs `process.stop` hooks at most once for the active process role.
 * Repeated shutdown triggers share the same completion promise.
 */
export function runProcessStop(role?: string): Promise<void> {
  const currentService = installed;
  if (!currentService || !currentService.hooks.has("process.stop")) {
    return Promise.resolve();
  }
  if (!stopRun) {
    const activeRole = startedRole ?? role ?? "";
    stopRun = currentService.hooks.run("process.stop", { role: activeRole });
  }
  return stopRun;
}

function current(): Service {
  if (!installed) {
    throw new Error(
      "No service is installed: read `service` inside a function, never while a module loads",
    );
  }
  return installed;
}

/**
 * The service of this process. It is installed once, by `run`, before the
 * process does anything else, and reading it earlier throws.
 */
export const service: Service = {
  get modules() {
    return current().modules;
  },
  get hooks() {
    return current().hooks;
  },
  get errors() {
    return current().errors;
  },
  get engines() {
    return current().engines;
  },
  get searchProviders() {
    return current().searchProviders;
  },
  get llmProviders() {
    return current().llmProviders;
  },
  get schemas() {
    return current().schemas;
  },
  get roles() {
    return current().roles;
  },
  get workers() {
    return current().workers;
  },
  mountRoutes: (routers: Routers) => current().mountRoutes(routers),
  describe: () => current().describe(),
};

/**
 * Swaps the installed service and returns the one it replaced. The role `run`
 * started belongs to the service it installed, so it is forgotten. For tests.
 */
export function replaceService(next: Service | undefined): Service | undefined {
  const previous = installed;
  installed = next;
  startedRole = undefined;
  stopRun = undefined;
  return previous;
}

/** Optional execution controls for `run()`. */
export interface RunOptions {
  /** Abort signal forwarded to the worker's `run()` environment. */
  signal?: AbortSignal;
}

/**
 * Starts one process role: checks the environment of every owner defined so
 * far, installs the service, runs `process.start` hooks, then runs the role.
 * The returned promise settles when the role's own start does.
 *
 * The check comes before the role runs. A role that loads its code only when
 * it runs can define an owner then, and that owner is checked where it is
 * defined.
 *
 * An unknown role, a second install, and an environment with a problem are
 * thrown synchronously from this call. A role that throws while it loads
 * throws synchronously when no `process.start` hook is registered, and
 * rejects the returned promise when `process.start` hooks run first.
 */
export function run(
  next: Service,
  role: string,
  entry: string,
  options?: RunOptions,
): Promise<void> {
  const worker = next.roles.get(role);
  if (!worker) {
    throw new Error(
      `Unknown role "${role}". Known roles: ${next.roles.names().join(", ")}`,
    );
  }
  if (installed) {
    throw new Error("A service is already installed in this process");
  }
  assertEnv();
  installed = next;
  startedRole = role;
  stopRun = undefined;
  const env: WorkerRunEnv =
    options?.signal !== undefined
      ? { entry, signal: options.signal }
      : { entry };
  if (!next.hooks.has("process.start")) {
    return Promise.resolve(worker.run(env));
  }
  return next.hooks.run("process.start", { role }).then(() => worker.run(env));
}
