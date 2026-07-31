import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";
import type { CategoryOption } from "../../lib/search-query-builder";
import {
  buildSearchProfileRequests,
  profileNames,
  resolveSearchProfiles,
} from "../profiles";
import type { InternalWebSearchResult } from "../quality";

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
  type = undefined,
  enterprise = undefined,
  routingQuery = undefined,
  categories = undefined,
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
  type?: SearchResultType | SearchResultType[];
  enterprise?: ("default" | "anon" | "zdr")[];
  routingQuery?: string;
  categories?: CategoryOption[];
}): Promise<SearchV2Response> {
  try {
    if (config.FIRE_ENGINE_BETA_URL) {
      logger.info("Using fire engine search");
      const results = await fire_engine_search_v2(query, {
        numResults: num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        type,
        enterprise,
      });

      return results;
    }

    if (config.SEARXNG_ENDPOINT) {
      const rawQuery = routingQuery ?? query;
      const profiles = resolveSearchProfiles(rawQuery, categories);
      const requests = profiles.flatMap(profile =>
        buildSearchProfileRequests(rawQuery, profile),
      );
      logger.info("Using intent-routed SearXNG search", {
        profiles: profileNames(profiles),
        engineGroups: requests.map(request => request.engines),
      });

      const responses = await Promise.all(
        requests.map(request =>
          searxng_search(request.query, {
            num_results,
            tbs,
            filter,
            lang,
            country,
            location,
            engines: request.engines,
            profile: request.profile,
            timeout,
            logger,
          }),
        ),
      );
      const web = responses.flatMap(
        response => (response.web ?? []) as InternalWebSearchResult[],
      );
      if (web.length > 0) return { web };
    }

    logger.info("Using DuckDuckGo search");
    const ddgResults = await ddgSearch(query, num_results, {
      tbs,
      lang,
      country,
      proxy,
      timeout,
    });
    if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;

    // Fallback to empty response
    return {};
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return {};
  }
}
