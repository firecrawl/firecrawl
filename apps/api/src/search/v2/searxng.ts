import axios from "axios";
import { config } from "../../config";
import { SearchV2Response } from "../../lib/entities";
import type { Logger } from "winston";
import type {
  InternalSearchDiagnostics,
  InternalWebSearchResult,
} from "../quality";
import type { SearchProfileName } from "../profiles";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  num_results: number;
  page?: number;
  engines?: string[];
  profile?: SearchProfileName;
  timeout?: number;
  logger: Logger;
}

interface SearxngResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  score?: unknown;
  publishedDate?: unknown;
}

interface SearxngResponse {
  results?: SearxngResult[];
  unresponsive_engines?: unknown;
}

function timeRangeFromTbs(tbs?: string): string | undefined {
  if (!tbs) return undefined;
  const value = tbs.toLowerCase();
  if (value.includes("qdr:h") || value.includes("qdr:d")) return "day";
  if (value.includes("qdr:w")) return "week";
  if (value.includes("qdr:m")) return "month";
  if (value.includes("qdr:y")) return "year";
  return undefined;
}

function diagnosticsOf(
  result: SearxngResult,
  profile?: SearchProfileName,
): InternalSearchDiagnostics {
  return {
    engine: typeof result.engine === "string" ? result.engine : undefined,
    engines: Array.isArray(result.engines)
      ? result.engines.filter((x): x is string => typeof x === "string")
      : undefined,
    score: typeof result.score === "number" ? result.score : undefined,
    publishedDate:
      typeof result.publishedDate === "string"
        ? result.publishedDate
        : undefined,
    profile,
  };
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

  const fetchPage = async (
    page: number,
  ): Promise<InternalWebSearchResult[]> => {
    const params = {
      q: q,
      language: options.lang,
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      engines:
        options.engines && options.engines.length > 0
          ? options.engines.join(",")
          : (config.SEARXNG_ENGINES ?? ""),
      categories:
        options.engines && options.engines.length > 0
          ? ""
          : (config.SEARXNG_CATEGORIES ?? ""),
      time_range: timeRangeFromTbs(options.tbs),
      pageno: page,
      format: "json",
    };

    const startedAt = Date.now();
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await axios.get(finalUrl, {
          headers: {
            "Content-Type": "application/json",
            // SearXNG is private to the Compose network and its limiter is off,
            // but the request parser still warns when neither forwarding
            // header exists.
            "X-Forwarded-For": "127.0.0.1",
            "X-Real-IP": "127.0.0.1",
          },
          params: params,
          timeout: Math.min(Math.max(options.timeout ?? 8000, 1000), 15000),
        });
        break;
      } catch (error) {
        const status = axios.isAxiosError(error)
          ? error.response?.status
          : undefined;
        const transient =
          status === undefined || status === 429 || status >= 500;
        if (attempt >= 1 || !transient) throw error;
        options.logger.warn("Retrying transient SearXNG request failure", {
          profile: options.profile,
          engines: options.engines,
          status,
        });
      }
    }

    const data = response!.data as SearxngResponse;
    const unresponsiveEngines = Array.isArray(data.unresponsive_engines)
      ? data.unresponsive_engines
      : [];

    options.logger.info("SearXNG engine group completed", {
      profile: options.profile,
      engines: options.engines,
      elapsedMs: Date.now() - startedAt,
      resultCount: Array.isArray(data.results) ? data.results.length : 0,
      unresponsiveEngines,
    });

    if (data && Array.isArray(data.results)) {
      return data.results.flatMap(a => {
        if (typeof a.url !== "string" || typeof a.title !== "string") return [];
        return [
          {
            url: a.url,
            title: a.title,
            description: typeof a.content === "string" ? a.content : "",
            __search: diagnosticsOf(a, options.profile),
          },
        ];
      });
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
    let webResults: InternalWebSearchResult[] = [];

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
    options.logger.error("SearXNG engine group failed", {
      profile: options.profile,
      engines: options.engines,
      error,
    });
    return {};
  }
}
