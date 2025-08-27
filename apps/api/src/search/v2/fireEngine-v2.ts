import dotenv from "dotenv";
import { SearchResult, SearchV2Response, SearchResultType } from "../../lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../../lib/logger";

dotenv.config();

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
  },
  abort?: AbortSignal,
): Promise<SearchV2Response> {
  try {
    let data = JSON.stringify({
      query: q,
      lang: options.lang,
      country: options.country,
      location: options.location,
      tbs: options.tbs,
      numResults: options.numResults,
      page: options.page ?? 1,
      type: options.type || 'web',
    });

    if (!process.env.FIRE_ENGINE_BETA_URL) {
      return {};
    }

    const response = await fetch(`${process.env.FIRE_ENGINE_BETA_URL}/v2/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Disable-Cache": "true",
      },
      body: data,
      signal: abort,
    });

    if (response.ok) {
      const responseData = await response.json();
      return responseData;
    } else {
      return {};
    }
  } catch (error) {
    logger.error(error);
    Sentry.captureException(error);
    return {};
  }
}

// Backward compatibility function
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
    type?: SearchResultType | SearchResultType[];
  },
  abort?: AbortSignal,
): Promise<SearchResult[]> {
  const result = await fire_engine_search_v2(q, options, abort);
  
  // Handle backward compatibility - convert to SearchResult array
  if (Array.isArray(result)) {
    return result;
  } else if (result.web) {
    return result.web.map(item => new SearchResult(item.url, item.title, item.description));
  }
  
  return [];
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
  try {
    let data = JSON.stringify({
      query: q,
      lang: options.lang,
      country: options.country,
      location: options.location,
      tbs: options.tbs,
      numResults: options.numResults,
      page: options.page ?? 1,
    });

    if (!process.env.FIRE_ENGINE_BETA_URL) {
      logger.warn("(v1/map Beta) Results might differ from cloud offering currently.");
      return [];
    }

    const response = await fetch(`${process.env.FIRE_ENGINE_BETA_URL}/map`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Disable-Cache": "true",
      },
      body: data,
      signal: abort,
    });

    if (response.ok) {
      const responseData = await response.json();
      return responseData;
    } else {
      return [];
    }
  } catch (error) {
    logger.error(error);
    Sentry.captureException(error);
    return [];
  }
}
