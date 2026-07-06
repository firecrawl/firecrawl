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
import { applySearchHighlights, highlightsEnvReady } from "./highlights";
import { trackSearchResults, trackSearchRequest } from "../lib/tracking";
import type { BillingMetadata } from "../services/billing/types";
import {
  filterSearchResponseWithWebRisk,
  FilterRiskyURLsOptions,
  WEB_RISK_CREDITS_PER_SCANNED_URL,
} from "./web-risk";

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
  includeDomains?: string[];
  excludeDomains?: string[];
  enterprise?: ("default" | "anon" | "zdr")[];
  scrapeOptions?: ScrapeOptions;
  highlights?: boolean;
  filterRiskyURLs?: FilterRiskyURLsOptions;
  timeout: number;
}

interface SearchContext {
  teamId: string;
  origin: string;
  apiKeyId: number | null;
  flags: TeamFlags;
  requestId: string;
  jobId: string;
  apiVersion: string;
  bypassBilling?: boolean;
  zeroDataRetention?: boolean;
  billing?: BillingMetadata;
  agentIndexOnly?: boolean;
  keylessReserved?: boolean;
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
    billing,
  } = context;

  const num_results_buffer = Math.floor(limit * 2);

  logger.info("Searching for results");

  const searchTypes = [...new Set(sources.map((s: any) => s.type))];
  const { query: searchQuery, categoryMap } = buildSearchQuery(
    query,
    categories,
    {
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
    },
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
  let riskFilterCredits = 0;
  let scrapeCredits = 0;

  if (options.filterRiskyURLs) {
    const filteringResult = await filterSearchResponseWithWebRisk(
      searchResponse,
      options.filterRiskyURLs,
      logger,
    );
    searchResponse.web = filteringResult.response.web;
    searchResponse.images = filteringResult.response.images;
    searchResponse.news = filteringResult.response.news;
    riskFilterCredits =
      filteringResult.scannedUrls * WEB_RISK_CREDITS_PER_SCANNED_URL;
    totalResultsCount =
      (searchResponse.web?.length ?? 0) +
      (searchResponse.images?.length ?? 0) +
      (searchResponse.news?.length ?? 0);
    logger.info("Google Web Risk filtering complete", {
      scannedUrls: filteringResult.scannedUrls,
      filteredUrls: filteringResult.filteredUrls,
      riskFilterCredits,
    });
  }

  const shouldScrape =
    scrapeOptions?.formats && scrapeOptions.formats.length > 0;

  if (shouldScrape && scrapeOptions) {
    const itemsToScrape = getItemsToScrape(searchResponse, flags, {
      team_id: teamId,
      origin,
    });

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
        billing,
        agentIndexOnly: context.agentIndexOnly,
        keylessReserved: context.keylessReserved,
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

  // Experimental highlights beta: replace provider snippets with index-backed
  // highlights. Gated on (1) the request opting in, (2) the team's highlightsBeta
  // flag, and (3) all required envs being present (index DB, GCS, model). Any
  // gate failing => silently keep the provider snippets.
  // Runs after scraping (mergeScrapedContent rebuilds the result objects, so
  // highlight mutations must come last to survive). Uses the user's original
  // query, not the domain-filtered upstream query.
  if (
    options.highlights &&
    flags?.highlightsBeta === true &&
    highlightsEnvReady()
  ) {
    await applySearchHighlights(searchResponse, query, logger);
  }

  const scrapeFormats = scrapeOptions?.formats
    ? scrapeOptions.formats.map((f: any) =>
        typeof f === "string" ? f : f.type,
      )
    : [];
  const totalSearchCredits = searchCredits + riskFilterCredits;

  trackSearchRequest({
    searchId: context.jobId,
    requestId: context.requestId,
    teamId,
    query,
    origin,
    kind: billing?.endpoint ?? "search",
    apiVersion: context.apiVersion,
    lang: options.lang,
    country: options.country,
    sources: searchTypes,
    numResults: totalResultsCount,
    searchCredits: totalSearchCredits,
    scrapeCredits,
    totalCredits: totalSearchCredits + scrapeCredits,
    hasScrapeFormats: shouldScrape ?? false,
    scrapeFormats,
    isSuccessful: true,
    timeTaken: 0, // filled by caller if needed
    zeroDataRetention: zeroDataRetention ?? false,
  }).catch(err =>
    logger.warn("Search request tracking failed", { error: err }),
  );

  trackSearchResults({
    searchId: context.jobId,
    teamId,
    response: searchResponse,
    zeroDataRetention: zeroDataRetention ?? false,
    hasScrapeFormats: shouldScrape ?? false,
  }).catch(err => logger.warn("Search tracking failed", { error: err }));

  return {
    response: searchResponse,
    totalResultsCount,
    searchCredits: totalSearchCredits,
    scrapeCredits,
    totalCredits: totalSearchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}
