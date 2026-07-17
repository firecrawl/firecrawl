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

export async function searxng_search(
  q: string,
  options: SearchOptions,
): Promise<SearchV2Response> {
  const requestedResults = Math.max(options.num_results, 0);
  const startPage = options.page ?? 1;

  if (requestedResults === 0) return {};

  const requestedTypes = normalizeRequestedTypes(options.type);
  const requestedTypeSet = new Set(requestedTypes);

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
    };

    const response = await axios.get(finalUrl, {
      headers: {
        "Content-Type": "application/json",
      },
      params: params,
    });

    const data = response.data;
    return data && Array.isArray(data.results) ? data.results : [];
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

    for (let pageOffset = 0; pageOffset < pagesToFetch; pageOffset += 1) {
      const pageResults = await fetchPage(startPage + pageOffset);
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
    logger.error(`There was an error searching for content`, { error });
    return {};
  }
}
