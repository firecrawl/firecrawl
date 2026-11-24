/*
 * The service: what one deployment of the API is made of, built once from a
 * config and read by the rest of the code.
 */
import type { TransportableErrorClass } from "../lib/error";
import {
  buildEngineRegistry,
  type DescribedEngineFeature,
  type Engine,
  type EngineFeatureMap,
  type EngineRegistry,
} from "./engines";
import { assertEnv, describeEnv } from "./env";
import {
  buildHooks,
  type HookHandlers,
  type HookPoints,
  type Hooks,
} from "./hooks";
import {
  buildLlmProviderRegistry,
  type LlmProvider,
  type LlmProviderRegistry,
} from "./llm-providers";

/**
 * The module slots: one implementation for each piece of behaviour the service
 * calls by name. A slot is added here together with the code that calls it.
 */
export interface Modules {}

/** A process role: what one process of the service runs. */
export interface Worker {
  /**
   * `entry` is the file that starts any role as `node <entry> <role>`. A role
   * that starts other processes starts them through it, whichever file its own
   * process was started from.
   */
  run(env: { entry: string }): void | Promise<void>;
}

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
   * LLM providers contributed by this extension. A later provider of the same
   * name replaces an earlier one.
   */
  llmProviders?: readonly LlmProvider[];
  /** Process roles, by name. A later extension replaces a role of the same name. */
  workers?: Record<string, Worker>;
}

/** The whole config. Everything that is not a slot belongs to a named extension. */
export interface ServiceConfig {
  modules: Modules;
  /** Applied in list order, after the service's own extension. */
  extensions?: Extension[];
}

export interface CoreParts {
  /** The service's own extension, applied first. */
  core: Extension;
  /** Where the service reports a failure it does not pass on to a caller. */
  logger: { error(message: string, meta: Record<string, unknown>): void };
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
  /** For each registered LLM provider, the extension it comes from. */
  llmProviders: Record<string, string>;
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
  readonly llmProviders: LlmProviderRegistry;
  readonly workers: Readonly<Record<string, Worker>>;
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

  const modules = Object.freeze({ ...config.modules });
  const workers: Record<string, Worker> = Object.freeze(
    Object.fromEntries(
      extensions.flatMap(extension => Object.entries(extension.workers ?? {})),
    ),
  );

  const hooks = buildHooks<HookPoints>(
    extensions.flatMap(extension => extension.hooks ?? []),
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

  const { registry: llmProviders, describedLlmProviders } =
    buildLlmProviderRegistry(
      extensions.map(extension => ({
        owner: extension.name,
        llmProviders: extension.llmProviders,
      })),
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

  // Worked out here, from the extensions as the handlers and roles above were
  // just read from them, so it stays true to what the service runs whatever
  // happens to an extension object later. The two records have no prototype,
  // so a name such as "constructor" is a key like any other.
  const handlerOwners: Record<string, string[]> = Object.create(null);
  const roleOwners: Record<string, string> = Object.create(null);
  for (const extension of extensions) {
    for (const [point, listed] of Object.entries(extension.hooks ?? {})) {
      const count = Array.isArray(listed) ? listed.length : listed ? 1 : 0;
      if (count === 0) continue;
      handlerOwners[point] = [
        ...(handlerOwners[point] ?? []),
        ...Array<string>(count).fill(extension.name),
      ];
    }
    for (const role of Object.keys(extension.workers ?? {})) {
      roleOwners[role] = extension.name;
    }
  }
  const baseDescription = {
    extensions: names,
    modules: Object.keys(modules).sort(),
    hooks: sortedByKey(handlerOwners),
    engines: describedEngines,
    engineFeatures: describedFeatures,
    llmProviders: describedLlmProviders,
    roles: sortedByKey(roleOwners),
  };

  return Object.freeze({
    modules,
    hooks,
    errors: Object.freeze({
      classFor: (code: string) => registeredErrors().get(code)?.errorClass,
    }),
    engines,
    llmProviders,
    workers,
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
        llmProviders: copy.llmProviders,
        roles: copy.roles,
        env: sortedByKey(describeEnv()),
      };
    },
  });
}

let installed: Service | undefined;
let startedRole: string | undefined;

/** The role `run` started in this process, or undefined when it has started none. */
export function processRole(): string | undefined {
  return startedRole;
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
  get llmProviders() {
    return current().llmProviders;
  },
  get workers() {
    return current().workers;
  },
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
  return previous;
}

/**
 * Starts one process role: checks the environment of every owner defined so
 * far, installs the service, then runs the role. The returned promise settles
 * when the role's own start does.
 *
 * The check comes before the role runs. A role that loads its code only when
 * it runs can define an owner then, and that owner is checked where it is
 * defined.
 *
 * An unknown role, a second install, an environment with a problem and a role
 * that throws while it loads are thrown from this call and not turned into a
 * rejection, so a process that cannot start fails the way a main module that
 * throws does.
 */
export function run(next: Service, role: string, entry: string): Promise<void> {
  if (!Object.hasOwn(next.workers, role)) {
    throw new Error(
      `Unknown role "${role}". Known roles: ${Object.keys(next.workers).sort().join(", ")}`,
    );
  }
  if (installed) {
    throw new Error("A service is already installed in this process");
  }
  assertEnv();
  installed = next;
  startedRole = role;
  return Promise.resolve(next.workers[role].run({ entry }));
}
