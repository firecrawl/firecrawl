import type { SearchV2Response, SearchResultType } from "../../lib/entities";
import type { Logger } from "winston";
import {
  SearchModeUnavailableError,
  UsOnlyUnavailableError,
} from "../../scraper/scrapeURL/error";
import { logger as baseLogger } from "../../lib/logger";
import type { TeamPlanClass } from "../../service/search-providers";
import { service } from "../../service";
import type { SearchQuery } from "../../service";
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
  type?: SearchResultType | Array<SearchResultType>;
  enterprise?: Array<"default" | "anon" | "zdr">;
  includeDomains?: Array<string>;
  excludeDomains?: Array<string>;
  usOnly?: boolean;
  /** The team's plan class, when the caller knows it. Omitted, nothing is stated. */
  teamPlanClass?: TeamPlanClass;
}): Promise<SearchV2Response> {
  const enabledProviders = service.searchProviders.enabled();
  const usProviders = usOnly
    ? enabledProviders.filter(provider => provider.supportsUsOnly === true)
    : enabledProviders;

  if (usOnly && usProviders.length === 0) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }

  const needsZdr = enterprise?.includes("zdr") === true;
  const needsAnon = enterprise?.includes("anon") === true;
  const providers = usProviders.filter(
    provider =>
      (!needsZdr || provider.supportsZdr === true) &&
      (!needsAnon || provider.supportsAnon === true),
  );

  if ((needsZdr || needsAnon) && providers.length === 0) {
    baseLogger.warn(
      "Search refused: no enabled provider supports the requested modes",
      {
        module: "search",
        method: "search",
        requestId,
        modes: [needsZdr && "zdr", needsAnon && "anon"].filter(Boolean),
        usOnly,
        enabledProviders: enabledProviders.map(provider => provider.name),
      },
    );
    throw new SearchModeUnavailableError();
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
      if (result !== null) {
        return result;
      }
    }

    // Fallback to empty response
    return {};
  } catch (error: unknown) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
