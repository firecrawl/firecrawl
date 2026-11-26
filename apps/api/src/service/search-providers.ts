/*
 * Search provider registry.
 *
 * `SearchProviders` is an open interface so packages built on the service can
 * add provider names by declaration merging.
 *
 * This file imports only types so creating or describing a service never loads
 * search provider implementations, configuration, or HTTP clients.
 */
import type { Logger } from "winston";
import type { SearchResultType, SearchV2Response } from "../lib/entities";
import type { RequestContext } from "./request-context";

/** Plan classification reported on search provider queries when known. */
export type TeamPlanClass = "free" | "self_serve" | "contract";

/**
 * Every search provider name, as the keys of an interface so that a package
 * built on this one can add its own by declaration merging.
 */
export interface SearchProviders {
  searxng: true;
  duckduckgo: true;
}

export type SearchProviderName = keyof SearchProviders;

/** Static registration metadata for a built-in search provider. */
export interface CoreSearchProviderSpec {
  readonly name: SearchProviderName;
  readonly priority: number;
  readonly supportsUsOnly?: boolean;
}

const builtInSearchProviders: Record<
  SearchProviderName,
  { readonly priority: number; readonly supportsUsOnly?: boolean }
> = {
  searxng: { priority: 50 },
  duckduckgo: { priority: 0 },
};

function isBuiltInSearchProviderName(name: string): name is SearchProviderName {
  return Object.hasOwn(builtInSearchProviders, name);
}

/** Built-in search provider names, in default priority order. */
export const coreSearchProviderNames: ReadonlyArray<SearchProviderName> =
  Object.freeze(
    Object.keys(builtInSearchProviders).filter(isBuiltInSearchProviderName),
  );

/**
 * Static metadata for built-in search providers, in default priority order.
 *
 * @internal
 */
export const coreSearchProviderSpecs: ReadonlyArray<CoreSearchProviderSpec> =
  Object.freeze(
    coreSearchProviderNames.map(name => {
      const spec = builtInSearchProviders[name];
      const entry: CoreSearchProviderSpec = spec.supportsUsOnly
        ? { name, priority: spec.priority, supportsUsOnly: true }
        : { name, priority: spec.priority };
      return Object.freeze(entry);
    }),
  );

/** Query parameters passed to a search provider. */
export interface SearchQuery {
  query: string;
  numResults: number;
  logger?: Logger;
  requestId?: string;
  advanced?: boolean;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleepInterval?: number;
  timeout?: number;
  page?: number;
  type?: SearchResultType | Array<SearchResultType>;
  enterprise?: Array<"default" | "anon" | "zdr">;
  includeDomains?: Array<string>;
  excludeDomains?: Array<string>;
  usOnly?: boolean;
  /** The team's plan class, when the caller knows it. Omitted, nothing is stated. */
  teamPlanClass?: TeamPlanClass;
  abort?: AbortSignal;
  /** Request context for providers that route by team or deployment terms. */
  ctx?: RequestContext;
  /** When true, requests the legacy search behavior used by v0/v1 endpoints. */
  legacy?: boolean;
}

/** A search provider registered on the service. */
export interface SearchProvider {
  readonly name: SearchProviderName;
  /**
   * Relative preference among enabled providers. Higher values are tried first;
   * ties preserve registration order.
   */
  readonly priority: number;
  /** Whether this provider handles US-only restricted search requests. */
  readonly supportsUsOnly?: boolean;
  /** Whether this provider handles requests with the `zdr` enterprise mode. */
  readonly supportsZdr?: boolean;
  /** Whether this provider handles requests with the `anon` enterprise mode. */
  readonly supportsAnon?: boolean;
  /** Whether this provider is active in the current deployment. Evaluated at call time. */
  enabled(): boolean;
  /**
   * Runs a search query. Returning `null` lets the dispatcher try the next
   * enabled provider; returning a response stops fallback.
   */
  search(query: SearchQuery): Promise<SearchV2Response | null>;
}

/** Description of a registered search provider in `ServiceDescription`. */
export interface DescribedSearchProvider {
  owner: string;
  priority: number;
}

/** The search providers registered on a service. */
export interface SearchProviderRegistry {
  /** Every registered provider in registration order, without calling `enabled()`. */
  all(): ReadonlyArray<SearchProvider>;
  /**
   * Providers whose `enabled()` returns true at call time, sorted by `priority`
   * descending with registration order breaking ties.
   */
  enabled(): ReadonlyArray<SearchProvider>;
  /** The registered provider for `name`, whether currently enabled or not. */
  get(name: SearchProviderName | (string & {})): SearchProvider | undefined;
}

/** @internal */
export interface SearchProviderRegistrySource {
  owner: string;
  searchProviders?: ReadonlyArray<SearchProvider>;
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

type MutableSearchProvider = {
  -readonly [K in keyof SearchProvider]: SearchProvider[K];
};

function snapshotSearchProvider(provider: SearchProvider): SearchProvider {
  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("Search provider name must be a non-empty string");
  }
  if (
    typeof provider.priority !== "number" ||
    !Number.isFinite(provider.priority)
  ) {
    throw new Error(
      `Search provider "${provider.name}" priority must be a finite number`,
    );
  }
  if (typeof provider.enabled !== "function") {
    throw new Error(
      `Search provider "${provider.name}" enabled must be a function`,
    );
  }
  if (typeof provider.search !== "function") {
    throw new Error(
      `Search provider "${provider.name}" search must be a function`,
    );
  }
  for (const flag of [
    "supportsUsOnly",
    "supportsZdr",
    "supportsAnon",
  ] as const) {
    if (provider[flag] !== undefined && typeof provider[flag] !== "boolean") {
      throw new Error(
        `Search provider "${provider.name}" ${flag} must be a boolean`,
      );
    }
  }

  const frozen: MutableSearchProvider = {
    name: provider.name,
    priority: provider.priority,
    enabled: provider.enabled.bind(provider),
    search: provider.search.bind(provider),
  };
  if (provider.supportsUsOnly) {
    frozen.supportsUsOnly = true;
  }
  if (provider.supportsZdr) {
    frozen.supportsZdr = true;
  }
  if (provider.supportsAnon) {
    frozen.supportsAnon = true;
  }
  return Object.freeze(frozen);
}

interface BuiltSearchProviderRegistry {
  registry: SearchProviderRegistry;
  describedSearchProviders: Record<string, DescribedSearchProvider>;
}

/**
 * Builds the frozen search provider registry and its description records from
 * extensions in registration order. A later registration of the same provider
 * name replaces an earlier one while keeping its registration slot.
 *
 * @internal
 */
export function buildSearchProviderRegistry(
  sources: ReadonlyArray<SearchProviderRegistrySource>,
): BuiltSearchProviderRegistry {
  const providersByName = new Map<
    string,
    { owner: string; provider: SearchProvider }
  >();

  for (const source of sources) {
    for (const provider of source.searchProviders ?? []) {
      providersByName.set(provider.name, {
        owner: source.owner,
        provider: snapshotSearchProvider(provider),
      });
    }
  }

  const allProviders = Object.freeze(
    [...providersByName.values()].map(entry => entry.provider),
  );

  const byPriority = Object.freeze(
    allProviders
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) =>
        b.provider.priority !== a.provider.priority
          ? b.provider.priority - a.provider.priority
          : a.index - b.index,
      )
      .map(entry => entry.provider),
  );

  const describedSearchProviders = sortedByKey(
    Object.fromEntries(
      [...providersByName].map(([name, { owner, provider }]) => [
        name,
        { owner, priority: provider.priority },
      ]),
    ),
  );

  const registry: SearchProviderRegistry = Object.freeze({
    all: () => allProviders,
    enabled: () =>
      Object.freeze(byPriority.filter(provider => provider.enabled())),
    get: (name: string) => providersByName.get(name)?.provider,
  });

  return { registry, describedSearchProviders };
}
