/*
 * Helpers for tests that need a service.
 */
import {
  createService,
  replaceService,
  type CoreParts,
  type Extension,
  type Modules,
  type ModulesConfig,
  type Service,
} from "./service";

/** Builds a service from module defaults or a base set, with any of them replaced and any extension added. */
export function testService(
  base: ModulesConfig,
  parts: CoreParts,
  overrides: Partial<Modules> = {},
  extensions: Extension[] = [],
): Service {
  const modules: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      modules[key] = value;
    }
  }
  return createService(
    { modules: modules as ModulesConfig, extensions },
    parts,
  );
}

/**
 * Installs a service while `fn` runs, then puts back what was installed before.
 *
 * A process has one installed service, so two uses must not overlap: one may
 * sit inside another, but tests that run concurrently in one file cannot each
 * have their own.
 */
export async function withService<T>(
  next: Service,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = replaceService(next);
  try {
    return await fn();
  } finally {
    replaceService(previous);
  }
}
