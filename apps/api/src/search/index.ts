import { SearchResult } from "../lib/entities";
import { Logger } from "winston";
import { search as searchV2 } from "./v2";
import { UsOnlyUnavailableError } from "../scraper/scrapeURL/error";
import { service, type SearchQuery } from "../service";
import { searchWithProvider } from "../lib/search-metrics";

export async function search({
  query,
  logger,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  usOnly = false,
  enterprise = undefined,
}: {
  query: string;
  logger: Logger;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  usOnly?: boolean;
  enterprise?: ("anon" | "zdr")[];
}): Promise<SearchResult[]> {
  // The legacy search route has no zero data retention or anonymous routing,
  // so a search that requires either goes through the v2 search.
  if (enterprise && enterprise.length > 0) {
    const response = await searchV2({
      query,
      logger,
      num_results,
      tbs,
      filter,
      lang,
      country,
      location,
      proxy,
      timeout,
      usOnly,
      enterprise,
    });
    return (response.web ?? []).map(
      result => new SearchResult(result.url, result.title, result.description),
    );
  }

  const enabledProviders = service.searchProviders.enabled();
  const providers = usOnly
    ? enabledProviders.filter(provider => provider.supportsUsOnly === true)
    : enabledProviders;

  if (usOnly && providers.length === 0) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }

  const searchQuery: SearchQuery = {
    query,
    logger,
    advanced,
    numResults: num_results,
    tbs,
    filter,
    lang,
    country,
    location,
    proxy,
    sleepInterval: sleep_interval,
    timeout,
    usOnly,
    legacy: true,
  };

  try {
    for (const provider of providers) {
      const response = await searchWithProvider(provider, searchQuery);
      if (response != null) {
        return (response.web ?? []).map(
          result =>
            new SearchResult(result.url, result.title, result.description),
        );
      }
    }

    return [];
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return [];
  }
}
