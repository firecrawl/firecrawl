/*
 * LLM provider registry.
 *
 * `LlmProviders` is an open interface so packages built on the service can add
 * provider names by declaration merging.
 *
 * This file imports only types so creating or describing a service never loads
 * provider implementations, configuration, or SDK clients.
 */
import type { wrapLanguageModel } from "ai";
import type { TeamFlags } from "../controllers/v2/types";
import type { RequestContext } from "./request-context";

/**
 * Every LLM provider name, as the keys of an interface so that a package built
 * on this one can add its own by declaration merging.
 */
export interface LlmProviders {
  openai: true;
  ollama: true;
  anthropic: true;
  groq: true;
  google: true;
  openrouter: true;
  fireworks: true;
  deepinfra: true;
  vertex: true;
}

export type LlmProviderName = keyof LlmProviders;

const builtInLlmProviders: Record<LlmProviderName, true> = {
  openai: true,
  ollama: true,
  anthropic: true,
  groq: true,
  google: true,
  openrouter: true,
  fireworks: true,
  deepinfra: true,
  vertex: true,
};

/** Built-in LLM provider names, in registration order. */
export const coreLlmProviderNames: readonly LlmProviderName[] = Object.freeze(
  Object.keys(builtInLlmProviders) as LlmProviderName[],
);

/** Language model instance returned by an LLM provider. */
export type LlmModel = Parameters<typeof wrapLanguageModel>[0]["model"];

/** Context passed to an LLM provider when resolving a language model. */
export interface LlmModelOptions {
  /** Request context for providers that route by team or deployment terms. */
  ctx?: RequestContext;
  /** Requesting team's flags, for callers not yet passing `ctx`. */
  teamFlags?: TeamFlags | null;
  /** Feature name used in errors when a model is unavailable for the caller. */
  feature?: string;
}

/** An LLM provider registered on the service. */
export interface LlmProvider {
  readonly name: LlmProviderName;
  /** Whether this provider is active in the current deployment. Evaluated at call time. */
  enabled(): boolean;
  /** Resolves an AI SDK language model for `id`. Synchronous. */
  model(id: string, options?: LlmModelOptions): LlmModel;
}

/** The LLM providers registered on a service. */
export interface LlmProviderRegistry {
  /** Every registered provider in registration order, without calling `enabled()`. */
  all(): readonly LlmProvider[];
  /** Providers whose `enabled()` returns true at call time, in registration order. */
  enabled(): readonly LlmProvider[];
  /** The registered provider for `name`, whether currently enabled or not. */
  get(name: LlmProviderName | (string & {})): LlmProvider | undefined;
}

/** @internal */
export interface LlmProviderRegistrySource {
  owner: string;
  llmProviders?: readonly LlmProvider[];
}

const sortedByKey = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

function snapshotLlmProvider(provider: LlmProvider): LlmProvider {
  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new Error("LLM provider name must be a non-empty string");
  }
  if (typeof provider.enabled !== "function") {
    throw new Error(
      `LLM provider "${provider.name}" enabled must be a function`,
    );
  }
  if (typeof provider.model !== "function") {
    throw new Error(`LLM provider "${provider.name}" model must be a function`);
  }

  return Object.freeze({
    name: provider.name,
    enabled: provider.enabled.bind(provider),
    model: provider.model.bind(provider),
  });
}

/**
 * Builds the frozen LLM provider registry and its description records from
 * extensions in registration order. A later registration of the same provider
 * name replaces an earlier one.
 *
 * @internal
 */
export function buildLlmProviderRegistry(
  sources: readonly LlmProviderRegistrySource[],
): {
  registry: LlmProviderRegistry;
  describedLlmProviders: Record<string, string>;
} {
  const providersByName = new Map<
    string,
    { owner: string; provider: LlmProvider }
  >();

  for (const source of sources) {
    for (const provider of source.llmProviders ?? []) {
      providersByName.set(provider.name, {
        owner: source.owner,
        provider: snapshotLlmProvider(provider),
      });
    }
  }

  const allProviders = Object.freeze(
    [...providersByName.values()].map(entry => entry.provider),
  );

  const describedLlmProviders = sortedByKey(
    Object.fromEntries(
      [...providersByName].map(([name, { owner }]) => [name, owner]),
    ),
  );

  const registry: LlmProviderRegistry = Object.freeze({
    all: () => allProviders,
    enabled: () =>
      Object.freeze(allProviders.filter(provider => provider.enabled())),
    get: name => providersByName.get(name)?.provider,
  });

  return { registry, describedLlmProviders };
}
