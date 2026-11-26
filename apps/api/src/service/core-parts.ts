/*
 * The service's own extension, applied first in every service: its process
 * roles, its scrape engines and feature priorities, its search providers, its
 * LLM providers, and its error classes.
 *
 * A role's module is loaded when the role runs and not before, so a process
 * loads only the code of the role it runs. For the same reason this file
 * imports only types and static metadata at the top: error classes are loaded
 * on the first error lookup, engine implementations are loaded on the first
 * engine call (`enabled`, `scrape`, or `maxReasonableTime`), search provider
 * implementations are loaded on the first provider call (`enabled` or
 * `search`), and LLM provider implementations are loaded on the first provider
 * call (`enabled` or `model`).
 */
import type { Meta } from "../scraper/scrapeURL";
import {
  coreEngineFeatures,
  coreEngineSpecs,
} from "../scraper/scrapeURL/engines/metadata";
import type { CoreEngineSpec } from "../scraper/scrapeURL/engines/metadata";
import type { coreErrors } from "../lib/error-serde";
import type { coreLlmProviders } from "../lib/generic-ai";
import type { logger } from "../lib/logger";
import type { coreEngines } from "../scraper/scrapeURL/engines";
import type { coreSearchProviders } from "../search/providers";
import type { Engine, EngineName } from "./engines";
import { coreLlmProviderNames } from "./llm-providers";
import type { LlmProvider, LlmProviderName } from "./llm-providers";
import { coreSearchProviderSpecs } from "./search-providers";
import type {
  CoreSearchProviderSpec,
  SearchProvider,
  SearchProviderName,
} from "./search-providers";
import { defaultBuildRequestSchemas } from "./request";
import type { CoreParts, Worker } from "./service";

interface StartableModule {
  start: Worker["run"];
}

function isStartableModule(value: unknown): value is StartableModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "start" in value &&
    typeof value.start === "function"
  );
}

function requireRoleModule(modulePath: string): StartableModule {
  const loaded: unknown = require(modulePath);
  if (!isStartableModule(loaded)) {
    throw new Error(`Role module "${modulePath}" does not export start()`);
  }
  return loaded;
}

function isCoreEnginesModule(
  value: unknown,
): value is { coreEngines: typeof coreEngines } {
  return (
    typeof value === "object" &&
    value !== null &&
    "coreEngines" in value &&
    Array.isArray(value.coreEngines)
  );
}

function isCoreSearchProvidersModule(
  value: unknown,
): value is { coreSearchProviders: typeof coreSearchProviders } {
  return (
    typeof value === "object" &&
    value !== null &&
    "coreSearchProviders" in value &&
    Array.isArray(value.coreSearchProviders)
  );
}

function isCoreLlmProvidersModule(
  value: unknown,
): value is { coreLlmProviders: typeof coreLlmProviders } {
  return (
    typeof value === "object" &&
    value !== null &&
    "coreLlmProviders" in value &&
    Array.isArray(value.coreLlmProviders)
  );
}

function isCoreErrorsModule(
  value: unknown,
): value is { coreErrors: typeof coreErrors } {
  return (
    typeof value === "object" &&
    value !== null &&
    "coreErrors" in value &&
    Array.isArray(value.coreErrors)
  );
}

function isLoggerModule(value: unknown): value is {
  logger: typeof logger;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "logger" in value &&
    typeof value.logger === "object" &&
    value.logger !== null &&
    "error" in value.logger &&
    typeof value.logger.error === "function"
  );
}

const role = (modulePath: string): Worker => ({
  run: env => requireRoleModule(modulePath).start(env),
});

const workers = {
  api: role("../index"),
  "queue-worker": role("../services/queue-worker"),
  "nuq-worker": role("../services/worker/nuq-worker"),
  "nuq-fdb-worker": role("../services/worker/nuq-fdb-worker"),
  "nuq-prefetch-worker": role("../services/worker/nuq-prefetch-worker"),
  "nuq-reconciler-worker": role("../services/worker/nuq-reconciler-worker"),
  harness: role("../harness"),
} satisfies Record<string, Worker>;

export function coreParts(): CoreParts {
  let loadedEngines: Map<EngineName, Engine> | undefined;
  const loadCoreEngine = (name: EngineName): Engine => {
    if (!loadedEngines) {
      const mod: unknown = require("../scraper/scrapeURL/engines");
      if (!isCoreEnginesModule(mod)) {
        throw new Error("Core engines module failed to export coreEngines");
      }
      loadedEngines = new Map(
        mod.coreEngines.map(engine => [engine.name, engine]),
      );
    }
    const engine = loadedEngines.get(name);
    if (!engine) {
      throw new Error(`Built-in engine "${name}" is not defined`);
    }
    return engine;
  };

  type MutableEngine = { -readonly [K in keyof Engine]: Engine[K] };
  const lazyEngine = (spec: CoreEngineSpec): Engine => {
    const scrape = (meta: Meta) => loadCoreEngine(spec.name).scrape(meta);
    Object.defineProperty(scrape, "name", { value: spec.method });
    const engine: MutableEngine = {
      name: spec.name,
      quality: spec.quality,
      features: spec.features,
      enabled: () => loadCoreEngine(spec.name).enabled(),
      scrape,
      maxReasonableTime: meta => {
        const loaded = loadCoreEngine(spec.name);
        return loaded.maxReasonableTime
          ? loaded.maxReasonableTime(meta)
          : 30_000;
      },
    };
    if (spec.explicitOnly) {
      engine.explicitOnly = true;
    }
    if (spec.cache) {
      engine.cache = true;
    }
    if (spec.fileOnly) {
      engine.fileOnly = true;
    }
    if (spec.supportsProfile) {
      engine.supportsProfile = true;
    }
    if (spec.prefetchesFiles) {
      engine.prefetchesFiles = true;
    }
    if (spec.allowEmptyContent) {
      engine.allowEmptyContent = true;
    }
    return engine;
  };

  let loadedSearchProviders:
    | Map<SearchProviderName, SearchProvider>
    | undefined;
  const loadCoreSearchProvider = (name: SearchProviderName): SearchProvider => {
    if (!loadedSearchProviders) {
      const mod: unknown = require("../search/providers");
      if (!isCoreSearchProvidersModule(mod)) {
        throw new Error(
          "Core search providers module failed to export coreSearchProviders",
        );
      }
      loadedSearchProviders = new Map(
        mod.coreSearchProviders.map(provider => [provider.name, provider]),
      );
    }
    const provider = loadedSearchProviders.get(name);
    if (!provider) {
      throw new Error(`Built-in search provider "${name}" is not defined`);
    }
    return provider;
  };

  type MutableSearchProvider = {
    -readonly [K in keyof SearchProvider]: SearchProvider[K];
  };
  const lazySearchProvider = (spec: CoreSearchProviderSpec): SearchProvider => {
    const provider: MutableSearchProvider = {
      name: spec.name,
      priority: spec.priority,
      enabled: () => loadCoreSearchProvider(spec.name).enabled(),
      search: query => loadCoreSearchProvider(spec.name).search(query),
    };
    if (spec.supportsUsOnly) {
      provider.supportsUsOnly = true;
    }
    return provider;
  };

  let loadedLlmProviders: Map<LlmProviderName, LlmProvider> | undefined;
  const loadCoreLlmProvider = (name: LlmProviderName): LlmProvider => {
    if (!loadedLlmProviders) {
      const mod: unknown = require("../lib/generic-ai");
      if (!isCoreLlmProvidersModule(mod)) {
        throw new Error(
          "Core LLM providers module failed to export coreLlmProviders",
        );
      }
      loadedLlmProviders = new Map(
        mod.coreLlmProviders.map(provider => [provider.name, provider]),
      );
    }
    const provider = loadedLlmProviders.get(name);
    if (!provider) {
      throw new Error(`Built-in LLM provider "${name}" is not defined`);
    }
    return provider;
  };

  const lazyLlmProvider = (name: LlmProviderName): LlmProvider => ({
    name,
    enabled: () => loadCoreLlmProvider(name).enabled(),
    model: (id, options) => loadCoreLlmProvider(name).model(id, options),
  });

  return {
    core: {
      name: "core",
      errors: () => {
        const mod: unknown = require("../lib/error-serde");
        if (!isCoreErrorsModule(mod)) {
          throw new Error(
            "Core error-serde module failed to export coreErrors",
          );
        }
        return mod.coreErrors;
      },
      engines: coreEngineSpecs.map(lazyEngine),
      engineFeatures: coreEngineFeatures,
      searchProviders: coreSearchProviderSpecs.map(lazySearchProvider),
      llmProviders: coreLlmProviderNames.map(lazyLlmProvider),
      workers,
    },
    logger: {
      error: (message, meta) => {
        const mod: unknown = require("../lib/logger");
        if (!isLoggerModule(mod)) {
          throw new Error("Core logger module failed to export logger");
        }
        mod.logger.error(message, meta);
      },
    },
    buildRequestSchemas: defaultBuildRequestSchemas,
  };
}
