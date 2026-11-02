import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";

/**
 * Thrown when every search provider that was tried failed (as opposed to
 * returning no results). Lets the API answer 503 with the reason instead of
 * an empty success that is indistinguishable from "nothing found".
 */
export class SearchProvidersUnavailableError extends Error {
  public readonly code = "SEARCH_PROVIDERS_UNAVAILABLE" as const;

  constructor(public readonly providerErrors: string[]) {
    super(`All search providers failed: ${providerErrors.join("; ")}`);
    this.name = "SearchProvidersUnavailableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
}): Promise<SearchV2Response> {
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
      });

      return results;
    }

    // includeDomains/excludeDomains are enforced on returned URLs only on
    // the fire engine path above; the fallback providers below receive them
    // solely as the site: chain baked into the query.
    const providerErrors: string[] = [];
    let providersTried = 0;

    if (config.SEARXNG_ENDPOINT) {
      providersTried += 1;
      logger.info("Using searxng search");
      try {
        const results = await searxng_search(query, {
          num_results,
          tbs,
          filter,
          lang,
          country,
          location,
          safe,
        });
        if (results.web && results.web.length > 0) return results;
        logger.info("SearXNG returned no results, falling back to DuckDuckGo");
      } catch (error) {
        providerErrors.push(`SearXNG: ${errorMessage(error)}`);
      }
    }

    providersTried += 1;
    logger.info("Using DuckDuckGo search");
    try {
      const ddgResults = await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      });
      if (ddgResults.web && ddgResults.web.length > 0) return ddgResults;
    } catch (error) {
      providerErrors.push(`DuckDuckGo: ${errorMessage(error)}`);
    }

    // Every provider errored: report it instead of an empty "success".
    if (providerErrors.length === providersTried) {
      throw new SearchProvidersUnavailableError(providerErrors);
    }

    // At least one provider answered and genuinely found nothing.
    return {};
  } catch (error) {
    if (error instanceof SearchProvidersUnavailableError) {
      logger.error("All search providers failed", {
        errors: error.providerErrors,
      });
      throw error;
    }
    logger.error(`Error in search function`, { error });
    return {};
  }
}
