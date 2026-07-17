import { config } from "../config";
import { SearchResult } from "../../src/lib/entities";
import { logger } from "../lib/logger";
import {
  fetchSearxngPage,
  SEARXNG_DEFAULT_TIMEOUT,
  SEARXNG_DEFAULT_RETRIES,
} from "./v2/searxng";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  num_results: number;
  page?: number;
}

// Thin v1 adapter: the HTTP fetch + timeout/retry/error classification is
// shared with v2 via fetchSearxngPage. This path keeps the legacy flat
// SearchResult[] contract and the SEARXNG_CATEGORIES knob for the v0/v1
// /search routes.
export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const fetchPage = async (page: number): Promise<SearchResult[]> => {
    const raw = await fetchSearxngPage(
      finalUrl,
      {
        q,
        language: options.lang,
        engines: config.SEARXNG_ENGINES ?? "",
        categories: config.SEARXNG_CATEGORIES ?? "",
        pageno: page,
        format: "json",
      },
      { timeout: SEARXNG_DEFAULT_TIMEOUT, maxRetries: SEARXNG_DEFAULT_RETRIES },
    );
    return raw.map((a: any) => ({
      url: a.url,
      title: a.title,
      description: a.content,
    }));
  };

  try {
    if (requestedResults === 0) {
      return [];
    }

    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / resultsPerPage),
    );
    let results: SearchResult[] = [];

    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      const pageResults = await fetchPage(startPage + pageOffset);
      if (pageResults.length === 0) {
        break;
      }
      results = results.concat(pageResults);
      if (results.length >= requestedResults) {
        break;
      }
    }

    return results.slice(0, requestedResults);
  } catch (error) {
    logger.error(`There was an error searching for content`, { error });
    return [];
  }
}
