/*
 * Process role (worker) registry.
 *
 * A deployment declares process roles on extensions under `workers`. A later
 * extension registering the same role name replaces an earlier one.
 *
 * This file imports nothing so creating or describing a service never loads
 * worker implementations, configuration, or clients.
 */

/** Environment passed to a worker role when it starts. */
export interface WorkerRunEnv {
  /**
   * The file that starts any role as `node <entry> <role>`. A role that starts
   * other processes starts them through it, whichever file its own process was
   * started from.
   */
  entry: string;
  /** Optional abort signal for cooperative shutdown when provided by the caller. */
  signal?: AbortSignal;
}

/** A process role: what one process of the service runs. */
export interface Worker {
  run(env: WorkerRunEnv): void | Promise<void>;
}

/** The process roles registered on a service. */
export interface RoleRegistry {
  /** Every registered role name, sorted alphabetically. */
  names(): ReadonlyArray<string>;
  /** Whether a role with `name` is registered on this service. */
  has(name: string): boolean;
  /** The registered worker for `name`, or undefined if unregistered. */
  get(name: string): Worker | undefined;
  /** The extension name that owns `name`, or undefined if unregistered. */
  owner(name: string): string | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, Worker> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @internal */
export interface WorkerRegistrySource {
  owner: string;
  workers?: Record<string, Worker>;
}

interface BuiltWorkerRegistry {
  roles: RoleRegistry;
  workers: Readonly<Record<string, Worker>>;
  describedRoles: Record<string, string>;
}

function isWorker(value: unknown): value is Worker {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof value.run === "function"
  );
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/**
 * Builds the frozen role registry, frozen worker lookup record, and role owner
 * description from extensions in registration order. A later extension
 * registering the same role name replaces an earlier one.
 *
 * @internal
 */
export function buildWorkerRegistry(
  sources: ReadonlyArray<WorkerRegistrySource>,
): BuiltWorkerRegistry {
  const byName = new Map<string, { owner: string; worker: Worker }>();

  for (const source of sources) {
    if (source.workers === undefined) {
      continue;
    }
    if (!isPlainRecord(source.workers)) {
      throw new Error(
        `Extension "${source.owner}" workers must be a plain object`,
      );
    }

    for (const [role, candidate] of Object.entries(source.workers)) {
      if (role.trim().length === 0) {
        throw new Error(
          `Extension "${source.owner}" worker role name must be a non-empty string`,
        );
      }
      if (!isWorker(candidate)) {
        throw new Error(
          `Worker "${role}" in extension "${source.owner}" must provide a run() function`,
        );
      }
      byName.set(role, { owner: source.owner, worker: candidate });
    }
  }

  const sortedNames = Object.freeze(
    [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const roleOwnerEntries: Array<[string, string]> = [];
  const workerEntries: Array<[string, Worker]> = [];
  for (const [role, entry] of byName) {
    roleOwnerEntries.push([role, entry.owner]);
    workerEntries.push([role, entry.worker]);
  }

  const workers: Readonly<Record<string, Worker>> = Object.freeze(
    Object.fromEntries(workerEntries),
  );

  const roles: RoleRegistry = Object.freeze({
    names: () => sortedNames,
    has: (name: string) => byName.has(name),
    get: (name: string) => byName.get(name)?.worker,
    owner: (name: string) => byName.get(name)?.owner,
  });

  return {
    roles,
    workers,
    describedRoles: sortedByKey(Object.fromEntries(roleOwnerEntries)),
  };
}
