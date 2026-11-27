import { Counter } from "prom-client";
import type { SearchProvider, SearchQuery } from "../service/search-providers";
import type { SearchV2Response } from "./entities";

// Fixed labels only: never put the query, team IDs, or request options here.
const searchProviderTotal = new Counter({
  name: "firecrawl_search_provider_total",
  help: "Search provider calls by outcome: served (answered with results), empty (answered with no results), skipped (returned null, so the next provider was tried) or error (threw)",
  labelNames: ["provider", "outcome"],
});

function outcomeOf(result: SearchV2Response | null) {
  if (result === null) {
    return "skipped";
  }
  const hasResults = Object.values(result).some(
    group => Array.isArray(group) && group.length > 0,
  );
  return hasResults ? "served" : "empty";
}

/** Calls the provider and counts its outcome. */
export async function searchWithProvider(
  provider: SearchProvider,
  query: SearchQuery,
): Promise<SearchV2Response | null> {
  try {
    const result = await provider.search(query);
    searchProviderTotal.inc({
      provider: provider.name,
      outcome: outcomeOf(result),
    });
    return result;
  } catch (error) {
    searchProviderTotal.inc({ provider: provider.name, outcome: "error" });
    throw error;
  }
}
