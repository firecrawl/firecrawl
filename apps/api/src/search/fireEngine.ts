import { config } from "../config";
import { SearchResult } from "../../src/lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";
import { executeWithRetry, attemptRequest } from "../lib/retry-utils";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;

function hasResults(results: unknown): results is SearchResult[] {
  return Array.isArray(results) && results.length > 0;
}

export async function fire_engine_search(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!useFireEngine) {
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/search`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}

export async function fireEngineMap(
  q: string,
  options: {
    tbs?: string;
    filter?: string;
    lang?: string;
    country?: string;
    location?: string;
    numResults: number;
    page?: number;
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  if (!useFireEngine) {
    logger.warn(
      "(v1/map Beta) Results might differ from cloud offering currently.",
    );
    return [];
  }

  const payload = {
    query: q,
    lang: options.lang,
    country: options.country,
    location: options.location,
    tbs: options.tbs,
    numResults: options.numResults,
    page: options.page ?? 1,
  };

  const url = `${config.FIRE_ENGINE_BETA_URL}/map`;
  const data = JSON.stringify(payload);

  const result = await executeWithRetry<SearchResult[]>(
    () => attemptRequest<SearchResult[]>(url, data, abort),
    hasResults,
    abort,
  );

  return result ?? [];
}
