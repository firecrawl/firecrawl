import { SearchV2Response, SearchResultType } from "../../lib/entities";
import { config } from "../../config";
import { fire_engine_search_v2 } from "./fireEngine-v2";
import { searxng_search } from "./searxng";
import { ddgSearch } from "./ddgsearch";
import { Logger } from "winston";

interface SearchV2Args {
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
}

interface SearchV2Outcome {
  response: SearchV2Response;
  /**
   * True when a provider served the query. False when every provider failed,
   * so an empty `response` means "we do not know", not "nothing matched".
   * Callers that bill must not charge for a failed search.
   */
  succeeded: boolean;
}

export async function searchWithOutcome({
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
}: SearchV2Args): Promise<SearchV2Outcome> {
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
      });

      if (results === null) {
        logger.error("Fire engine search failed on every attempt");
        return { response: {}, succeeded: false };
      }

      return { response: results, succeeded: true };
    }

    // Did any provider serve the query? An empty response from a provider
    // that ran means "nothing matched" and bills. A provider that failed says
    // nothing at all, so it must not bill.
    let served = false;

    if (config.SEARXNG_ENDPOINT) {
      logger.info("Using searxng search");
      const results = await searxng_search(query, {
        num_results,
        tbs,
        filter,
        lang,
        country,
        location,
        safe,
      });
      if (results !== null) {
        served = true;
        if (results.web && results.web.length > 0)
          return { response: results, succeeded: true };
      }
    }

    // Still try DuckDuckGo when searxng found nothing: the fallback is what
    // keeps result quality up. But a DuckDuckGo failure must not erase a
    // searxng that already served.
    logger.info("Using DuckDuckGo search");
    try {
      const ddgResults = await ddgSearch(query, num_results, {
        tbs,
        lang,
        country,
        proxy,
        timeout,
      });
      served = true;
      if (ddgResults.web && ddgResults.web.length > 0)
        return { response: ddgResults, succeeded: true };
    } catch (error) {
      logger.error("DuckDuckGo search failed", { error });
    }

    // Every provider that ran found nothing. `served` is false when none did.
    return { response: {}, succeeded: served };
  } catch (error) {
    logger.error(`Error in search function`, { error });
    return { response: {}, succeeded: false };
  }
}

export async function search(args: SearchV2Args): Promise<SearchV2Response> {
  return (await searchWithOutcome(args)).response;
}
