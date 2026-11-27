import axios from "axios";
import { config } from "../../config";
import type { SearchV2Response, WebSearchResult } from "../../lib/entities";
import { logger } from "../../lib/logger";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  safe?: boolean;
  num_results: number;
  page?: number;
}

interface SearxngApiResult {
  url: string;
  title: string;
  content: string;
}

interface SearxngApiResponse {
  results?: Array<SearxngApiResult>;
}

interface SearxngParams {
  q: string;
  language: string | undefined;
  engines: string;
  categories: string;
  pageno: number;
  format: string;
  safesearch?: number;
}

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT;
  if (!url) {
    return {};
  }
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const fetchPage = async (page: number): Promise<Array<WebSearchResult>> => {
    const params: SearxngParams = {
      q,
      language: options.lang,
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      engines: config.SEARXNG_ENGINES ?? "",
      categories: config.SEARXNG_CATEGORIES ?? "",
      pageno: page,
      format: "json",
    };
    if (options.safe) {
      // 2 = strict; omitted otherwise so the instance default applies
      params.safesearch = 2;
    }

    const response = await axios.get<SearxngApiResponse>(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params,
    });

    const data = response.data;

    if (data && Array.isArray(data.results)) {
      return data.results.map(a => ({
        url: a.url,
        title: a.title,
        description: a.content,
      }));
    }

    return [];
  };

  try {
    if (requestedResults === 0) {
      return {};
    }

    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / resultsPerPage),
    );
    let webResults: Array<WebSearchResult> = [];

    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      const pageResults = await fetchPage(startPage + pageOffset);
      if (pageResults.length === 0) {
        break;
      }
      webResults = webResults.concat(pageResults);
      if (webResults.length >= requestedResults) {
        break;
      }
    }

    return webResults.length > 0
      ? {
          web: webResults.slice(0, requestedResults),
        }
      : {};
  } catch (error: unknown) {
    logger.error(`There was an error searching for content`, { error });
    return {};
  }
}
