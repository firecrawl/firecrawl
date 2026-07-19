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
import { applyIndexedSearchHighlights, highlightsEnvReady } from "./highlights";
import { runSearchHighlightsShadow } from "./highlights-shadow";
import { trackSearchResults, trackSearchRequest } from "../lib/tracking";
import type { BillingMetadata } from "../services/billing/types";
import type { ThreatProtectionPolicy } from "../lib/threat-protection/types";
import { checkUrlsAgainstThreatPolicy } from "../lib/threat-protection/request";
import { calculateThreatScanCredits } from "../lib/scrape-billing";

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
  /** Effective threat protection policy; blocked domains are removed from results entirely. */
  threatProtectionPolicy?: ThreatProtectionPolicy | null;
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

  // Threat protection: remove blocked results entirely — before
  // slicing/counting, before scraping, and before returning. Checks are
  // URL-level and deduped within this request; scan fees bill +2 per unique
  // scanned URL (see calculateThreatScanCredits), charged as part of the
  // search credits below.
  let threatScanCredits = 0;
  const threatPolicy = context.threatProtectionPolicy;
  if (threatPolicy && threatPolicy.mode !== "off") {
    const urlsToCheck = [
      ...(searchResponse.web ?? []).map(x => x.url),
      ...(searchResponse.news ?? []).map(x => x.url),
      ...(searchResponse.images ?? []).map(x => x.url),
    ].filter((x): x is string => !!x);

    if (urlsToCheck.length > 0) {
      const { decisionsByUrl } = await checkUrlsAgainstThreatPolicy(
        urlsToCheck,
        threatPolicy,
        { teamId },
      );
      threatScanCredits = calculateThreatScanCredits(decisionsByUrl.values());
      const isAllowed = (url: string | undefined | null): boolean => {
        if (!url) return true;
        const decision = decisionsByUrl.get(url);
        return decision === undefined || decision.allowed;
      };
      if (searchResponse.web) {
        searchResponse.web = searchResponse.web.filter(x => isAllowed(x.url));
      }
      if (searchResponse.news) {
        searchResponse.news = searchResponse.news.filter(x => isAllowed(x.url));
      }
      if (searchResponse.images) {
        searchResponse.images = searchResponse.images.filter(x =>
          isAllowed(x.url),
        );
      }
    }
  }

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
  // Threat protection scan fees ride on the search credits: they are part of
  // serving the search itself (every result domain is scanned before
  // filtering), so they bill against the same feature and show up in the
  // request's creditsUsed.
  const searchCredits =
    Math.ceil(totalResultsCount / 10) * creditsPerTenResults +
    threatScanCredits;
  let scrapeCredits = 0;

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
        threatProtectionPolicy: threatPolicy ?? null,
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
  const shouldApplyHighlights =
    options.highlights &&
    flags?.highlightsBeta === true &&
    highlightsEnvReady();
  if (shouldApplyHighlights) {
    await applyIndexedSearchHighlights(
      searchResponse,
      query,
      logger,
      context.requestId,
    );
  } else {
    runSearchHighlightsShadow({
      response: searchResponse,
      query,
      requestId: context.requestId,
      teamId,
      zeroDataRetention: zeroDataRetention === true || isZDR === true,
    });
  }

  const scrapeFormats = scrapeOptions?.formats
    ? scrapeOptions.formats.map((f: any) =>
        typeof f === "string" ? f : f.type,
      )
    : [];

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
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
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
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
  };
}
