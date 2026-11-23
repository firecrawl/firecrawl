import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import { UsOnlyUnavailableError } from "../../scraper/scrapeURL/error";
import { matchesDomains } from "../operators";
import type { TeamPlanClass } from "../../lib/team-plan-class";

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
  // The fallback backends below take no US-only routing.
  if (usOnly && !config.FIRE_ENGINE_BETA_URL) {
    throw new UsOnlyUnavailableError(
      "Search is not available for teams restricted to US-only processing on this deployment.",
    );
  }
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        requestId,
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
        type,
        enterprise,
        includeDomains,
        excludeDomains,
        usOnly,
        teamPlanClass,
      });

      return results;
    }

    // The providers below get the domains only as site: operators in the
    // query, which they don't always honour, so their results are checked here.
    const inDomains = (results: SearchV2Response) =>
      (results.web ?? []).filter(result =>
        matchesDomains(result.url, includeDomains, excludeDomains),
      );

    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const web = inDomains(
        await searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
          safe,
        }),
      );
      if (web.length > 0) return { web };
    }

    logger.info("Using DuckDuckGo search");
    const ddgWeb = inDomains(
      await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      }),
    );
    if (ddgWeb.length > 0) return { web: ddgWeb };

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
