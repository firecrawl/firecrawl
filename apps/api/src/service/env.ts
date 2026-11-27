/*
 * Environment variables that belong to one part of the service. A module or an
 * extension declares the variables it reads under its own name, and reads them
 * from the object it gets back.
 *
 * An owner is defined while its module is constructed, which is before a
 * service exists, so the owners are kept for the process and not on a service.
 * A value that does not fit its schema does not stop the definition:
 * `assertEnv` reports the problems of every owner together.
 *
 * This file imports nothing but types, and loads nothing until the first owner
 * is defined.
 */
import type { z } from "zod";

const owners = new Map<string, { keys: Set<string>; problems: Set<string> }>();
let asserted = false;

const report = (problems: Array<string>) =>
  `Invalid environment:\n${problems.map(problem => `  ${problem}`).join("\n")}`;

function createThrowingEnvStub<T>(
  keys: ReadonlyArray<string>,
  errorMessage: string,
): T;
function createThrowingEnvStub(
  keys: ReadonlyArray<string>,
  errorMessage: string,
) {
  const unreadable = {};
  for (const key of keys) {
    Object.defineProperty(unreadable, key, {
      enumerable: true,
      get(): never {
        throw new Error(errorMessage);
      },
    });
  }
  return unreadable;
}

/**
 * Declares the environment variables one owner reads and returns their parsed
 * values. The schema is an object with one key per variable, and a check
 * across variables is a refinement of that object. Only those variables are
 * read from the environment, whatever the object does with other keys. A
 * variable that is set and empty reaches its schema as an empty string, and
 * that schema decides whether it counts as unset.
 *
 * When the environment does not fit the schema, the problems are kept for
 * `assertEnv` and reading any of the owner's variables throws. A definition
 * made after `assertEnv` has run throws its problems itself. A later
 * definition under the same name adds to the earlier one: the owner lists the
 * variables of both, and a problem of either is reported.
 */
export function defineEnv<Schema extends z.ZodObject>(
  owner: string,
  schema: Schema,
): z.output<Schema> {
  // A .env file is read before the first owner, as it is before the config.
  require("dotenv/config");

  const keys = Object.keys(schema.shape).sort();
  const parsed = schema.safeParse(
    Object.fromEntries(
      keys
        .filter(key => Object.hasOwn(process.env, key))
        .map(key => [key, process.env[key]]),
    ),
  );

  const kept = owners.get(owner) ?? {
    keys: new Set<string>(),
    problems: new Set<string>(),
  };
  owners.set(owner, kept);
  for (const key of keys) {
    kept.keys.add(key);
  }
  if (parsed.success) {
    return parsed.data;
  }

  const problems = parsed.error.issues.map(issue =>
    [owner, ...issue.path.map(String), issue.message].join(": "),
  );
  for (const problem of problems) {
    kept.problems.add(problem);
  }
  if (asserted) {
    throw new Error(report(problems));
  }

  return createThrowingEnvStub<z.output<Schema>>(keys, report(problems));
}

/**
 * Throws when the environment of any owner has a problem, and lists the
 * problems of all of them. `run` calls it before it starts a role.
 */
export function assertEnv(): void {
  asserted = true;
  const problems = [...owners.keys()]
    .sort()
    .flatMap(owner => [...(owners.get(owner)?.problems ?? [])]);
  if (problems.length > 0) {
    throw new Error(report(problems));
  }
}

/** The variables each owner declares. Each call returns a copy. */
export function describeEnv(): Record<string, Array<string>> {
  return Object.fromEntries(
    [...owners].map(([owner, { keys }]) => [owner, [...keys].sort()]),
  );
}
