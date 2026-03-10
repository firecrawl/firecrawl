import type { Logger } from "winston";
import { search } from "./v2";
import { SearchV2Response } from "../lib/entities";
import {
  buildSearchQuery,
  getCategoryFromUrl,
  CategoryOption,
} from "../lib/search-query-builder";
import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import {
  getItemsToScrape,
  scrapeSearchResults,
  mergeScrapedContent,
  calculateScrapeCredits,
} from "./scrape";

interface SearchOptions {
  query: string;
  limit: number;
  tbs?: string;
  filter?: string;
  lang?: string;
  country?: string;
  location?: string;
  sources: Array<{ type: string }>;
  categories?: CategoryOption[];
  enterprise?: ("default" | "anon" | "zdr")[];
  scrapeOptions?: ScrapeOptions;
  timeout: number;
}

interface SearchContext {
  teamId: string;
  origin: string;
  apiKeyId: number | null;
  flags: TeamFlags;
  requestId: string;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
}

interface SearchExecuteResult {
  response: SearchV2Response;
  totalResultsCount: number;
  searchCredits: number;
  scrapeCredits: number;
  totalCredits: number;
  shouldScrape: boolean;
}

export async function executeSearch(
  options: SearchOptions,
  context: SearchContext,
  logger: Logger,
): Promise<SearchExecuteResult> {
  const { query, limit, sources, categories, scrapeOptions } = options;
  const {
    teamId,
    origin,
    apiKeyId,
    flags,
    requestId,
    bypassBilling,
    zeroDataRetention,
  } = context;

  const num_results_buffer = Math.floor(limit * 2);

  logger.info("Searching for results");

  const searchTypes = [...new Set(sources.map((s: any) => s.type))];
  const { query: searchQuery, categoryMap } = buildSearchQuery(
    query,
    categories,
  );

  const searchResponse = (await search({
    query: searchQuery,
    logger,
    advanced: false,
    num_results: num_results_buffer,
    tbs: options.tbs,
    filter: options.filter,
    lang: options.lang,
    country: options.country,
    location: options.location,
    type: searchTypes,
    enterprise: options.enterprise,
  })) as SearchV2Response;

  if (searchResponse.web && searchResponse.web.length > 0) {
    searchResponse.web = searchResponse.web.map(result => ({
      ...result,
      category: getCategoryFromUrl(result.url, categoryMap),
    }));
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    searchResponse.news = searchResponse.news.map(result => ({
      ...result,
      category: result.url
        ? getCategoryFromUrl(result.url, categoryMap)
        : undefined,
    }));
  }

  let totalResultsCount = 0;

  if (searchResponse.web && searchResponse.web.length > 0) {
    if (searchResponse.web.length > limit) {
      searchResponse.web = searchResponse.web.slice(0, limit);
    }
    totalResultsCount += searchResponse.web.length;
  }

  if (searchResponse.images && searchResponse.images.length > 0) {
    if (searchResponse.images.length > limit) {
      searchResponse.images = searchResponse.images.slice(0, limit);
    }
    totalResultsCount += searchResponse.images.length;
  }

  if (searchResponse.news && searchResponse.news.length > 0) {
    if (searchResponse.news.length > limit) {
      searchResponse.news = searchResponse.news.slice(0, limit);
    }
    totalResultsCount += searchResponse.news.length;
  }

  const isZDR = options.enterprise?.includes("zdr");
  const creditsPerTenResults = isZDR ? 10 : 2;
  const searchCredits =
    Math.ceil(totalResultsCount / 10) * creditsPerTenResults;
  let scrapeCredits = 0;

  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    const itemsToScrape = getItemsToScrape(searchResponse, flags);

    if (itemsToScrape.length > 0) {
      const scrapeOpts = {
        teamId,
        origin,
        timeout: options.timeout,
        scrapeOptions,
        bypassBilling: bypassBilling ?? false,
        apiKeyId,
        zeroDataRetention,
        requestId,
      };

      const allDocsWithCostTracking = await scrapeSearchResults(
        itemsToScrape.map(i => i.scrapeInput),
        scrapeOpts,
        logger,
        flags,
      );

      mergeScrapedContent(
        searchResponse,
        itemsToScrape,
        allDocsWithCostTracking,
      );
      scrapeCredits = calculateScrapeCredits(allDocsWithCostTracking);
    }
  }

  return {
    response: searchResponse,
    totalResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}
