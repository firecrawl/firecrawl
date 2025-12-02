import dotenv from "dotenv";
import {
  SearchResult,
  SearchV2Response,
  SearchResultType,
} from "../../lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../../lib/logger";
import { executeWithRetry, attemptRequest } from "../../lib/retry-utils";

dotenv.config();

const useFireEngine =
  process.env.FIRE_ENGINE_BETA_URL !== "" &&
  process.env.FIRE_ENGINE_BETA_URL !== undefined;

function normalizeSearchTypes(
  type?: SearchResultType | SearchResultType[],
): SearchResultType[] {
  if (!type) return ["web"];
  return Array.isArray(type) ? type : [type];
}

function hasCompleteResults(
  response: SearchV2Response,
  requestedTypes: SearchResultType[],
): boolean {
  return requestedTypes.every(type => {
    const results = response[type];
    return Array.isArray(results) && results.length > 0;
  });
}

export async function fire_engine_search_v2(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
    type?: SearchResultType | SearchResultType[];
    retry?: boolean;
  },
  abort?: AbortSignal,
): Promise<SearchV2Response> {
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
  };

  const requestedTypes = normalizeSearchTypes(options.type);
  const url = `${process.env.FIRE_ENGINE_BETA_URL}/v2/search`;
  const data = JSON.stringify(payload);

  const retry = options.retry ?? true;

  if (retry) {
    const result = await executeWithRetry<SearchV2Response>(
      () => attemptRequest<SearchV2Response>(url, data, abort),
      (response): response is SearchV2Response =>
        response !== null && hasCompleteResults(response, requestedTypes),
      abort,
    );

    return result ?? {};
  }

  const result = await attemptRequest<SearchV2Response>(url, data, abort);

  return result ?? {};
}
