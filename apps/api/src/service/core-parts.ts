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
  type CoreEngineSpec,
} from "../scraper/scrapeURL/engines/metadata";
import type { Engine, EngineName } from "./engines";
import {
  coreLlmProviderNames,
  type LlmProvider,
  type LlmProviderName,
} from "./llm-providers";
import {
  coreSearchProviderSpecs,
  type CoreSearchProviderSpec,
  type SearchProvider,
  type SearchProviderName,
} from "./search-providers";
import { defaultBuildRequestSchemas } from "./request";
import type { CoreParts, Worker } from "./service";

const role = (load: () => { start: Worker["run"] }): Worker => ({
  run: env => load().start(env),
});

const workers: Record<string, Worker> = {
  api: role(() => require("../index") as typeof import("../index")),
  "queue-worker": role(
    () =>
      require("../services/queue-worker") as typeof import("../services/queue-worker"),
  ),
  "nuq-worker": role(
    () =>
      require("../services/worker/nuq-worker") as typeof import("../services/worker/nuq-worker"),
  ),
  "nuq-fdb-worker": role(
    () =>
      require("../services/worker/nuq-fdb-worker") as typeof import("../services/worker/nuq-fdb-worker"),
  ),
  "nuq-prefetch-worker": role(
    () =>
      require("../services/worker/nuq-prefetch-worker") as typeof import("../services/worker/nuq-prefetch-worker"),
  ),
  "nuq-reconciler-worker": role(
    () =>
      require("../services/worker/nuq-reconciler-worker") as typeof import("../services/worker/nuq-reconciler-worker"),
  ),
  harness: role(() => require("../harness") as typeof import("../harness")),
};

export function coreParts(): CoreParts {
  let loadedEngines: Map<EngineName, Engine> | undefined;
  const loadCoreEngine = (name: EngineName): Engine => {
    if (!loadedEngines) {
      const { coreEngines } =
        require("../scraper/scrapeURL/engines") as typeof import("../scraper/scrapeURL/engines");
      loadedEngines = new Map(coreEngines.map(engine => [engine.name, engine]));
    }
    const engine = loadedEngines.get(name);
    if (!engine) {
      throw new Error(`Built-in engine "${name}" is not defined`);
    }
    return engine;
  };

  const lazyEngine = (spec: CoreEngineSpec): Engine => {
    const scrape = (meta: Meta) => loadCoreEngine(spec.name).scrape(meta);
    Object.defineProperty(scrape, "name", { value: spec.method });
    return {
      name: spec.name,
      quality: spec.quality,
      features: spec.features,
      ...(spec.explicitOnly ? { explicitOnly: true } : {}),
      ...(spec.cache ? { cache: true } : {}),
      ...(spec.fileOnly ? { fileOnly: true } : {}),
      ...(spec.supportsProfile ? { supportsProfile: true } : {}),
      ...(spec.prefetchesFiles ? { prefetchesFiles: true } : {}),
      ...(spec.allowEmptyContent ? { allowEmptyContent: true } : {}),
      enabled: () => loadCoreEngine(spec.name).enabled(),
      scrape,
      maxReasonableTime: meta => {
        const loaded = loadCoreEngine(spec.name);
        return loaded.maxReasonableTime
          ? loaded.maxReasonableTime(meta)
          : 30000;
      },
    };
  };

  let loadedSearchProviders:
    | Map<SearchProviderName, SearchProvider>
    | undefined;
  const loadCoreSearchProvider = (name: SearchProviderName): SearchProvider => {
    if (!loadedSearchProviders) {
      const { coreSearchProviders } =
        require("../search/providers") as typeof import("../search/providers");
      loadedSearchProviders = new Map(
        coreSearchProviders.map(provider => [provider.name, provider]),
      );
    }
    const provider = loadedSearchProviders.get(name);
    if (!provider) {
      throw new Error(`Built-in search provider "${name}" is not defined`);
    }
    return provider;
  };

  const lazySearchProvider = (
    spec: CoreSearchProviderSpec,
  ): SearchProvider => ({
    name: spec.name,
    priority: spec.priority,
    ...(spec.supportsUsOnly ? { supportsUsOnly: true } : {}),
    enabled: () => loadCoreSearchProvider(spec.name).enabled(),
    search: query => loadCoreSearchProvider(spec.name).search(query),
  });

  let loadedLlmProviders: Map<LlmProviderName, LlmProvider> | undefined;
  const loadCoreLlmProvider = (name: LlmProviderName): LlmProvider => {
    if (!loadedLlmProviders) {
      const { coreLlmProviders } =
        require("../lib/generic-ai") as typeof import("../lib/generic-ai");
      loadedLlmProviders = new Map(
        coreLlmProviders.map(provider => [provider.name, provider]),
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
      errors: () =>
        (require("../lib/error-serde") as typeof import("../lib/error-serde"))
          .coreErrors,
      engines: coreEngineSpecs.map(lazyEngine),
      engineFeatures: coreEngineFeatures,
      searchProviders: coreSearchProviderSpecs.map(lazySearchProvider),
      llmProviders: coreLlmProviderNames.map(lazyLlmProvider),
      workers,
    },
    logger: {
      error: (message, meta) => {
        (
          require("../lib/logger") as typeof import("../lib/logger")
        ).logger.error(message, meta);
      },
    },
    buildRequestSchemas: defaultBuildRequestSchemas,
  };
}
