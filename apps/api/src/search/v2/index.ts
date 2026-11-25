import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
import type { TeamPlanClass } from "../../lib/team-plan-class";
import { service, type SearchQuery } from "../../service";
import { searchWithProvider } from "../../lib/search-metrics";

export async function search({
  query,
  logger,
  requestId,
  advanced = false,
  num_results = 5,
  tbs = undefined,
  filter = undefined,
  lang = "en",
  country = "us",
  location = undefined,
  safe = undefined,
  proxy = undefined,
  sleep_interval = 0,
  timeout = 5000,
  type = undefined,
  enterprise = undefined,
  includeDomains = undefined,
  excludeDomains = undefined,
  usOnly = false,
  teamPlanClass = undefined,
}: {
  query: string;
  logger: Logger;
  requestId?: string;
  advanced?: boolean;
  num_results?: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  proxy?: string;
  sleep_interval?: number;
  timeout?: number;
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  includeDomains?: string[];
  excludeDomains?: string[];
  usOnly?: boolean;
  /** The team's plan class, when the caller knows it. Omitted, nothing is stated. */
  teamPlanClass?: TeamPlanClass;
}): Promise<SearchV2Response> {
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
    requestId,
    advanced,
    numResults: num_results,
    tbs,
    filter,
    lang,
    country,
    location,
    safe,
    proxy,
    sleepInterval: sleep_interval,
    timeout,
    type,
    enterprise,
    includeDomains,
    excludeDomains,
    usOnly,
    teamPlanClass,
  };

  try {
    for (const provider of providers) {
      const result = await searchWithProvider(provider, searchQuery);
      if (result != null) {
        return result;
      }
    }

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
