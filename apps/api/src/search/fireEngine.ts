import dotenv from "dotenv";
import { SearchResult } from "../../src/lib/entities";
import * as Sentry from "@sentry/node";
import { logger } from "../lib/logger";

dotenv.config();


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
      return [];
    }

    const response = await fetch(`${process.env.FIRE_ENGINE_BETA_URL}/search`, {
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
