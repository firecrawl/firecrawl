import axios from "axios";
import { config } from "../../config";
import { SearchV2Response, WebSearchResult } from "../../lib/entities";
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

// Firecrawl accepts Google-style tbs values ("qdr:d", "qdr:w", ...) and bare
// "d"/"w"/"m"/"y". SearXNG only knows day/week/month/year, so the past hour is
// widened to a day; custom date ranges are not supported and are ignored.
const TIME_RANGES: Record<string, string> = {
  h: "day",
  d: "day",
  w: "week",
  m: "month",
  y: "year",
};

export function tbsToTimeRange(tbs?: string): string | undefined {
  if (!tbs) return undefined;
  const match = /(?:^|qdr:)([hdwmy])(?:$|[\d,])/.exec(tbs.trim());
  return match ? TIME_RANGES[match[1]] : undefined;
}

// Bing answers Hebrew/Arabic (right-to-left script) queries with unrelated
// pages (microsoft.com, US retail sites), so leave it out for those queries.
const RTL_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const RTL_UNRELIABLE_ENGINES = new Set(["bing"]);

export function enginesForQuery(q: string, engines?: string): string {
  if (!engines || !RTL_SCRIPT.test(q)) return engines ?? "";
  const kept = engines
    .split(",")
    .map(e => e.trim())
    .filter(e => e && !RTL_UNRELIABLE_ENGINES.has(e.toLowerCase()));
  return kept.length > 0 ? kept.join(",") : engines;
}

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const resultsPerPage = 20;
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  const timeRange = tbsToTimeRange(options.tbs);

  const fetchPage = async (page: number): Promise<WebSearchResult[]> => {
    const params = {
      q: q,
      // Firecrawl defaults lang to "en"; forcing that makes engines return
      // English pages for Hebrew/Arabic/Cyrillic queries. Let SearXNG detect
      // the query language unless the caller asked for another language.
      language:
        options.lang && options.lang !== "en" ? options.lang : "auto",
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      engines: enginesForQuery(q, config.SEARXNG_ENGINES),
      categories: config.SEARXNG_CATEGORIES ?? "",
      pageno: page,
      format: "json",
      // 2 = strict; omitted otherwise so the instance default applies
      ...(options.safe ? { safesearch: 2 } : {}),
      ...(timeRange ? { time_range: timeRange } : {}),
    };

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
      timeout: 15000,
    });

    const data = response.data;

    if (data && Array.isArray(data.results)) {
      return data.results.map((a: any) => ({
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
    let webResults: WebSearchResult[] = [];

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
  } catch (error) {
    // Let the caller decide: it falls back to DuckDuckGo and reports an error
    // only if every provider failed.
    logger.warn(`SearXNG search failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
