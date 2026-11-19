/*
 * The service: what one deployment of the API is made of, built once from a
 * config and read by the rest of the code.
 */
import {
  buildHooks,
  type HookHandlers,
  type HookPoints,
  type Hooks,
} from "./hooks";

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
  /** For each process role, the extension it comes from. */
  roles: Record<string, string>;
}

export interface Service {
  readonly modules: Readonly<Modules>;
  readonly hooks: Hooks;
  readonly workers: Readonly<Record<string, Worker>>;
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
    Object.assign({}, ...extensions.map(extension => extension.workers ?? {})),
  );

  return Object.freeze({
    modules,
    hooks: buildHooks<HookPoints>(
      extensions.flatMap(extension => extension.hooks ?? []),
      (hook, error) =>
        parts.logger.error("Hook handler failed", { hook, error }),
    ),
    workers,
    describe() {
      const hooks: Record<string, string[]> = {};
      const roles: Record<string, string> = {};
      for (const extension of extensions) {
        for (const [point, listed] of Object.entries(extension.hooks ?? {})) {
          const count = Array.isArray(listed) ? listed.length : listed ? 1 : 0;
          if (count === 0) continue;
          hooks[point] = [
            ...(hooks[point] ?? []),
            ...Array<string>(count).fill(extension.name),
          ];
        }
        for (const role of Object.keys(extension.workers ?? {})) {
          roles[role] = extension.name;
        }
      }
      return {
        extensions: names,
        modules: Object.keys(modules).sort(),
        hooks: sortedByKey(hooks),
        roles: sortedByKey(roles),
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
  get workers() {
    return current().workers;
  },
  describe: () => current().describe(),
};

/** Swaps the installed service and returns the one it replaced. For tests. */
export function replaceService(next: Service | undefined): Service | undefined {
  const previous = installed;
  installed = next;
  return previous;
}

/**
 * Starts one process role: installs the service, then runs the role. The
 * returned promise settles when the role's own start does.
 *
 * An unknown role, a second install and a role that throws while it loads are
 * thrown from this call and not turned into a rejection, so a process that
 * cannot start fails the way a main module that throws does.
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
  installed = next;
  startedRole = role;
  return Promise.resolve(next.workers[role].run({ entry }));
}
