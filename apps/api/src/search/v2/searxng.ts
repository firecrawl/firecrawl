import axios from "axios";
import { config } from "../../config";
import {
  SearchV2Response,
  WebSearchResult,
  SearchResultType,
} from "../../lib/entities";
import { logger } from "../../lib/logger";

interface SearchOptions {
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  num_results: number;
  page?: number;
  type?: SearchResultType | SearchResultType[];
  timeout?: number;
  maxRetries?: number;
}

// Firecrawl's source buckets map onto SearXNG's category taxonomy. SearXNG
// tags every result with its own `category`, so a single comma-joined
// `categories` request returns a mixed set we can bucket on the way back.
const SOURCE_TO_SEARXNG_CATEGORY: Record<SearchResultType, string> = {
  web: "general",
  images: "images",
  news: "news",
};

const RESULTS_PER_PAGE = 20;

const SEARXNG_DEFAULT_TIMEOUT = 5000;
const SEARXNG_DEFAULT_RETRIES = 1;

function parseImageResolution(
  resolution: unknown,
): { imageWidth?: number; imageHeight?: number } {
  if (typeof resolution !== "string") return {};
  const match = resolution.match(/^(\d+)x(\d+)$/);
  return match
    ? { imageWidth: Number(match[1]), imageHeight: Number(match[2]) }
    : {};
}

function normalizeRequestedTypes(
  type: SearchOptions["type"],
): SearchResultType[] {
  const raw = type ? (Array.isArray(type) ? type : [type]) : [];
  const deduped = Array.from(new Set(raw));
  return deduped.length > 0 ? deduped : ["web"];
}

// Maps Firecrawl's Google-style `tbs` time filter (e.g. "qdr:d") onto SearXNG's
// `time_range` param. SearXNG only supports day/week/month/year (no hour, no
// custom ranges), so unknown/custom values map to undefined (no filter).
const TBS_TO_SEARXNG_RANGE: Record<string, "day" | "week" | "month" | "year"> = {
  h: "day", // SearXNG has no hour granularity; day is the closest
  d: "day",
  w: "week",
  m: "month",
  y: "year",
};

export function tbsToSearxngTimeRange(
  tbs?: string,
): "day" | "week" | "month" | "year" | undefined {
  if (typeof tbs !== "string") return undefined;
  const cleaned = tbs.trim().toLowerCase();
  const g = cleaned.match(/qdr:([hdwmy])/)?.[1];
  if (!g && !["h", "d", "w", "m", "y"].includes(cleaned)) return undefined;
  return TBS_TO_SEARXNG_RANGE[g ?? cleaned];
}

export type SearxngErrorKind =
  | "timeout"
  | "network"
  | "http_server"
  | "http_client"
  | "parse"
  | "unknown";

export interface SearxngErrorInfo {
  kind: SearxngErrorKind;
  status?: number;
  message: string;
  retryable: boolean;
}

// Maps an axios/runtime failure onto a classified, retry-aware descriptor so
// the caller can log distinctly and decide whether to retry. Grounded in the
// codes axios 1.x emits: ERR_CANCELED (AbortController), ERR_NETWORK,
// ERR_BAD_RESPONSE (5xx), ERR_BAD_REQUEST (4xx).
export function classifySearxngError(error: unknown): SearxngErrorInfo {
  const e = error as { code?: string; message?: string; name?: string };
  const code = e?.code;
  const status = (
    error as { response?: { status?: number } }
  )?.response?.status;

  if (code === "ERR_CANCELED") {
    return {
      kind: "timeout",
      message: "request aborted (timeout)",
      retryable: true,
    };
  }
  if (code === "ERR_NETWORK") {
    return {
      kind: "network",
      message: e?.message ?? "network error",
      retryable: true,
    };
  }
  if (typeof status === "number") {
    if (status >= 500) {
      return {
        kind: "http_server",
        status,
        message: `searxng returned ${status}`,
        retryable: true,
      };
    }
    if (status >= 400) {
      // 429 is a transient rate limit — retry it; other 4xx are caller bugs.
      return {
        kind: "http_client",
        status,
        message: `searxng returned ${status}`,
        retryable: status === 429,
      };
    }
  }
  if (e?.name === "SyntaxError" || code === "ERR_BAD_RESPONSE") {
    return {
      kind: "parse",
      message: e?.message ?? "response parse error",
      retryable: false,
    };
  }
  return {
    kind: "unknown",
    message: e?.message ?? String(error),
    retryable: false,
  };
}

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;
  const timeout = Math.max(options.timeout ?? SEARXNG_DEFAULT_TIMEOUT, 1);
  const maxRetries = Math.max(
    options.maxRetries ?? SEARXNG_DEFAULT_RETRIES,
    0,
  );

  if (requestedResults === 0) return {};

  const requestedTypes = normalizeRequestedTypes(options.type);
  const requestedTypeSet = new Set(requestedTypes);
  const timeRange = tbsToSearxngTimeRange(options.tbs);

  const url = config.SEARXNG_ENDPOINT!;
  const cleanedUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const finalUrl = cleanedUrl + "/search";

  // Per-request source types drive the SearXNG category filter. Fall back to
  // the global SEARXNG_CATEGORIES only when no type was supplied.
  const searxngCategories =
    requestedTypes.map(t => SOURCE_TO_SEARXNG_CATEGORY[t]).join(",") ||
    (config.SEARXNG_CATEGORIES ?? "");

  const fetchPage = async (page: number): Promise<any[]> => {
    const params = {
      q: q,
      language: options.lang,
      // gl: options.country, //not possible with SearXNG
      // location: options.location, //not possible with SearXNG
      // num: options.num_results, //not possible with SearXNG
      engines: config.SEARXNG_ENGINES ?? "",
      categories: searxngCategories,
      pageno: page,
      format: "json",
      ...(timeRange ? { time_range: timeRange } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await axios.get(finalUrl, {
          headers: { "Content-Type": "application/json" },
          params,
          signal: controller.signal,
        });
        const data = response.data;
        return data && Array.isArray(data.results) ? data.results : [];
      } catch (error) {
        lastError = error;
        const info = classifySearxngError(error);
        if (!info.retryable || attempt === maxRetries) break;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
    throw lastError;
  };

  const webResults: WebSearchResult[] = [];
  const imageResults: NonNullable<SearchV2Response["images"]> = [];
  const newsResults: NonNullable<SearchV2Response["news"]> = [];

  const bucket = (r: any) => {
    const category: string = typeof r.category === "string" ? r.category : "";

    if (category === "general" && requestedTypeSet.has("web")) {
      webResults.push({
        url: r.url,
        title: r.title,
        description: r.content,
      });
    } else if (category === "images" && requestedTypeSet.has("images")) {
      imageResults.push({
        title: r.title,
        imageUrl: r.img_src,
        url: r.url,
        ...parseImageResolution(r.resolution),
      });
    } else if (category === "news" && requestedTypeSet.has("news")) {
      newsResults.push({
        title: r.title,
        url: r.url,
        snippet: r.content,
        date: r.publishedDate || r.pubdate || undefined,
        imageUrl: r.thumbnail || undefined,
      });
    }
  };

  try {
    const pagesToFetch = Math.max(
      1,
      Math.ceil(requestedResults / RESULTS_PER_PAGE),
    );

    let pageError: SearxngErrorInfo | null = null;

    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      let pageResults: any[];
      try {
        pageResults = await fetchPage(startPage + pageOffset);
      } catch (error) {
        pageError = classifySearxngError(error);
        logger.warn("SearXNG page fetch failed", {
          page: startPage + pageOffset,
          ...pageError,
        });
        break;
      }
      if (pageResults.length === 0) {
        break;
      }
      for (const r of pageResults) {
        bucket(r);
      }
      const total =
        webResults.length + imageResults.length + newsResults.length;
      if (total >= requestedResults) {
        break;
      }
    }

    const total =
      webResults.length + imageResults.length + newsResults.length;

    if (total === 0) {
      // Distinguish "SearXNG errored" from "SearXNG returned nothing" so the
      // DuckDuckGo fallback in the dispatcher is observable in logs.
      if (pageError) {
        logger.warn("SearXNG search failed; falling back", {
          query: q,
          ...pageError,
        });
      } else {
        logger.info("SearXNG returned no results", { query: q });
      }
    }

    const response: SearchV2Response = {};
    if (webResults.length > 0) {
      response.web = webResults.slice(0, requestedResults);
    }
    if (imageResults.length > 0) {
      response.images = imageResults.slice(0, requestedResults);
    }
    if (newsResults.length > 0) {
      response.news = newsResults.slice(0, requestedResults);
    }
    return response;
  } catch (error) {
    logger.error("Unexpected SearXNG failure", { query: q, error });
    return {};
  }
}
