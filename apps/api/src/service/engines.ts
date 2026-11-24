/*
 * Scrape engine and engine-feature registries.
 *
 * `Engines` and `EngineFeatures` are open interfaces so packages built on the
 * service can add engine names and feature flags by declaration merging.
 *
 * This file imports only types so creating or describing a service never loads
 * engine implementations, configuration, or clients.
 */
import type { Meta } from "../scraper/scrapeURL";
import type { EngineScrapeResult } from "../scraper/scrapeURL/engines";

/**
 * Every scrape engine name, as the keys of an interface so that a package built
 * on this one can add its own by declaration merging.
 */
export interface Engines {
  wikipedia: true;
  playwright: true;
  fetch: true;
  pdf: true;
  document: true;
}

export type EngineName = keyof Engines;

/**
 * Every scrape engine feature flag, as the keys of an interface so that a
 * package built on this one can add its own by declaration merging.
 */
export interface EngineFeatures {
  actions: true;
  waitFor: true;
  screenshot: true;
  "screenshot@fullScreen": true;
  pdf: true;
  document: true;
  image: true;
  atsv: true;
  location: true;
  mobile: true;
  skipTlsVerification: true;
  useFastMode: true;
  stealthProxy: true;
  disableAdblock: true;
}

export type EngineFeatureName = keyof EngineFeatures;

/** Scoring weight for an engine feature flag during engine selection. */
export interface EngineFeature {
  /** Non-negative weight used to score how well an engine matches requested features. */
  readonly priority: number;
}

/** Map of feature names to their registered definitions. */
export type EngineFeatureMap = {
  readonly [F in EngineFeatureName]?: EngineFeature;
};

/**
 * A scrape engine registered on the service.
 */
export interface Engine {
  readonly name: EngineName;
  /**
   * Relative preference among engines with the same feature support score.
   * Higher values are tried first; negative values are reserved for specialty
   * engines (such as file parsers or stealth tiers).
   */
  readonly quality: number;
  /** Features this engine supports. Absent or false means unsupported. */
  readonly features: { readonly [F in EngineFeatureName]?: boolean };
  /** Whether this engine is active in the current deployment. Evaluated at call time. */
  enabled(): boolean;
  scrape(meta: Meta): Promise<EngineScrapeResult>;
  /** Upper bound in milliseconds before waterfalling to the next engine. Defaults to 30000. */
  maxReasonableTime?(meta: Meta): number;
  /** When true, omitted from automatic fallback selection and only run when chosen explicitly. */
  readonly explicitOnly?: boolean;
  /** When true, serves cached scrape results (lockdown, index-only, cache state). */
  readonly cache?: boolean;
  /** When true, parses binary files only rather than fetching general HTML pages. */
  readonly fileOnly?: boolean;
  /** When true, supports authenticated browser profiles. */
  readonly supportsProfile?: boolean;
  /** When true, can prefetch binary files via a browser handoff. */
  readonly prefetchesFiles?: boolean;
  /** When true, a 2xx or 304 response with empty text and no page error is accepted as a complete document. */
  readonly allowEmptyContent?: boolean;
}

/** Description of a registered engine feature in `ServiceDescription`. */
export interface DescribedEngineFeature {
  owner: string;
  priority: number;
}

/** The scrape engines and feature priorities registered on a service. */
export interface EngineRegistry {
  /** Every registered engine in registration order, without calling `enabled()`. */
  all(): readonly Engine[];
  /** Engines whose `enabled()` returns true at call time, in registration order. */
  enabled(): readonly Engine[];
  /** The registered engine for `name`, whether currently enabled or not. */
  get(name: EngineName | (string & {})): Engine | undefined;
  /** The registered definition for `name`, or undefined if unregistered. */
  feature(
    name: EngineFeatureName | (string & {}),
  ): Readonly<EngineFeature> | undefined;
  /** Every registered feature definition, keyed by feature name. */
  features(): Readonly<Record<string, Readonly<EngineFeature>>>;
}

/** @internal */
export interface EngineRegistrySource {
  owner: string;
  engines?: readonly Engine[];
  engineFeatures?: EngineFeatureMap;
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

function snapshotEngine(engine: Engine): Engine {
  if (typeof engine.name !== "string" || engine.name.length === 0) {
    throw new Error("Engine name must be a non-empty string");
  }
  if (typeof engine.quality !== "number" || !Number.isFinite(engine.quality)) {
    throw new Error(`Engine "${engine.name}" quality must be a finite number`);
  }
  if (typeof engine.enabled !== "function") {
    throw new Error(`Engine "${engine.name}" enabled must be a function`);
  }
  if (typeof engine.scrape !== "function") {
    throw new Error(`Engine "${engine.name}" scrape must be a function`);
  }
  if (
    engine.maxReasonableTime !== undefined &&
    typeof engine.maxReasonableTime !== "function"
  ) {
    throw new Error(
      `Engine "${engine.name}" maxReasonableTime must be a function`,
    );
  }

  const features = Object.freeze(
    Object.fromEntries(
      Object.entries(engine.features ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, Boolean(value)]),
    ),
  ) as { readonly [F in EngineFeatureName]?: boolean };

  const frozen: Engine = {
    name: engine.name,
    quality: engine.quality,
    features,
    enabled: engine.enabled,
    scrape: engine.scrape,
    ...(engine.maxReasonableTime !== undefined
      ? { maxReasonableTime: engine.maxReasonableTime }
      : {}),
    ...(engine.explicitOnly ? { explicitOnly: true } : {}),
    ...(engine.cache ? { cache: true } : {}),
    ...(engine.fileOnly ? { fileOnly: true } : {}),
    ...(engine.supportsProfile ? { supportsProfile: true } : {}),
    ...(engine.prefetchesFiles ? { prefetchesFiles: true } : {}),
    ...(engine.allowEmptyContent ? { allowEmptyContent: true } : {}),
  };
  return Object.freeze(frozen);
}

/**
 * Builds the frozen engine registry and its description records from extensions
 * in registration order. A later registration of the same engine or feature
 * name replaces an earlier one.
 *
 * @internal
 */
export function buildEngineRegistry(sources: readonly EngineRegistrySource[]): {
  registry: EngineRegistry;
  describedEngines: Record<string, string>;
  describedFeatures: Record<string, DescribedEngineFeature>;
} {
  const enginesByName = new Map<string, { owner: string; engine: Engine }>();
  const featuresByName = new Map<
    string,
    { owner: string; feature: Readonly<EngineFeature> }
  >();

  for (const source of sources) {
    for (const engine of source.engines ?? []) {
      enginesByName.set(engine.name, {
        owner: source.owner,
        engine: snapshotEngine(engine),
      });
    }

    for (const [name, feature] of Object.entries(source.engineFeatures ?? {})) {
      if (feature === undefined) continue;
      if (
        typeof feature.priority !== "number" ||
        !Number.isFinite(feature.priority) ||
        feature.priority < 0
      ) {
        throw new Error(
          `Engine feature "${name}" priority must be a non-negative finite number`,
        );
      }
      featuresByName.set(name, {
        owner: source.owner,
        feature: Object.freeze({ priority: feature.priority }),
      });
    }
  }

  const allEngines = Object.freeze(
    [...enginesByName.values()].map(entry => entry.engine),
  );
  const allFeatures = Object.freeze(
    sortedByKey(
      Object.fromEntries(
        [...featuresByName].map(([name, { feature }]) => [name, feature]),
      ),
    ),
  );

  const describedEngines = sortedByKey(
    Object.fromEntries(
      [...enginesByName].map(([name, { owner }]) => [name, owner]),
    ),
  );
  const describedFeatures = sortedByKey(
    Object.fromEntries(
      [...featuresByName].map(([name, { owner, feature }]) => [
        name,
        { owner, priority: feature.priority },
      ]),
    ),
  );

  const registry: EngineRegistry = Object.freeze({
    all: () => allEngines,
    enabled: () => Object.freeze(allEngines.filter(engine => engine.enabled())),
    get: name => enginesByName.get(name)?.engine,
    feature: name => featuresByName.get(name)?.feature,
    features: () => allFeatures,
  });

  return { registry, describedEngines, describedFeatures };
}
