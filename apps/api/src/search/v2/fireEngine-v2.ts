import { config } from "../../config";
import { SearchV2BackendResponse, SearchResultType } from "../../lib/entities";
import { logger } from "../../lib/logger";
import { requestSearchBackend } from "../../lib/retry-utils";
import { useFireEngine } from "../../scraper/scrapeURL/engines/fire-engine/available";

const SEARCH_TYPES: SearchResultType[] = ["web", "images", "news"];

/**
 * Checks if the response has at least one requested type with results.
 * This allows partial results to be returned when some sources have data
 * but others don't, instead of requiring all sources to have results.
 *
 * MOGERY: temp removed to fix bug
 */
// function hasAnyResults(
//   response: SearchV2Response,
//   requestedTypes: SearchResultType[],
// ): boolean {
//   if (!response || Object.keys(response).length === 0) return false;
//   return requestedTypes.some(type => {
//     const results = response[type];
//     return Array.isArray(results) && results.length > 0;
//   });
// }

export async function fire_engine_search_v2(
  q: string,
  options: {
    requestId?: string;
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    safe?: boolean;
    numResults: number;
    page?: number;
    type?: SearchResultType | SearchResultType[];
    enterprise?: ("default" | "anon" | "zdr")[];
    includeDomains?: string[];
    excludeDomains?: string[];
    usOnly?: boolean;
  },
  abort?: AbortSignal,
): Promise<SearchV2BackendResponse> {
  if (!useFireEngine) {
    logger.warn(
      "FIRE_ENGINE_BETA_URL is not configured, returning empty search results",
    );
    return {};
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
    type: options.type || "web",
    enterprise: options.enterprise,
    safe: options.safe ? ("active" as const) : undefined,
    includeDomains: options.includeDomains,
    excludeDomains: options.excludeDomains,
    ...(options.usOnly ? { usOnly: true } : {}),
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/v2/search`;
  const data = JSON.stringify(payload);

  const result = await requestSearchBackend<SearchV2BackendResponse>(
    url,
    data,
    abort,
    options.requestId,
  );
  if (result === null) return {};

  const { failedTypes: reportedFailedTypes, ...response } = result;
  const failedTypes = Array.isArray(reportedFailedTypes)
    ? reportedFailedTypes.filter(type => SEARCH_TYPES.includes(type))
    : [];
  return failedTypes.length > 0 ? { ...response, failedTypes } : response;
}
