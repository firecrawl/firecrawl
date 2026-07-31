import { config } from "../../config";
import type { WebSearchResult } from "../../lib/entities";

interface CapabilityMatch {
  capability: string;
  creditsPerCall?: number;
  name?: string;
  operation?: string;
  provider: string;
  providerName?: string;
  summary?: string;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Finds Exchange capabilities matching a query and shapes them as ordinary
 * search results, so a caller reads a provider the same way it reads a page.
 */
interface ExchangeDiscoveryFilters {
  capabilities?: string[];
  categories?: string[];
  providers?: string[];
}

export async function discoverExchangeCapabilities(input: {
  filters?: ExchangeDiscoveryFilters;
  limit: number;
  query: string;
}): Promise<WebSearchResult[]> {
  if (!config.EXCHANGE_API_URL || !input.query.trim()) return [];

  const url = new URL("/v1/router", config.EXCHANGE_API_URL);
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(input.limit));
  for (const [key, values] of Object.entries(input.filters ?? {})) {
    if (values?.length) url.searchParams.set(key, values.join(","));
  }

  type DiscoveryPayload = { results?: CapabilityMatch[] };
  let payload: DiscoveryPayload | null = null;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(config.EXCHANGE_API_TOKEN
          ? { Authorization: `Bearer ${config.EXCHANGE_API_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    payload = (await response
      .json()
      .catch(() => null)) as DiscoveryPayload | null;
  } catch {
    // Discovery is additive: a catalog outage must not fail the web search.
    return [];
  }

  return (payload?.results ?? [])
    .filter(match => match.provider && match.capability)
    .map(match => ({
      url: `https://www.firecrawl.dev/exchange/${match.provider}`,
      title: `${match.providerName ?? match.provider} — ${match.name ?? match.capability}`,
      description: describe(match),
    }));
}

/** States the keys a caller needs rather than pasting a snippet into prose. */
function describe(match: CapabilityMatch): string {
  const price =
    typeof match.creditsPerCall === "number"
      ? `${match.creditsPerCall} credits per call.`
      : undefined;
  return [
    match.summary?.trim(),
    price,
    `Run it with provider "${match.provider}" and capability "${match.capability}".`,
  ]
    .filter(Boolean)
    .join(" ");
}
