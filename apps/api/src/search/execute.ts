import type { Logger } from "winston";
import { config } from "../config";
import { search } from "./v2";
import { rerankWebResults } from "./v2/reranker";
import { attachRagPassages } from "./v2/rag";
import { buildGroundedAnswer, checkSufficiency, buildSnippets } from "./v2/grounded-answer";
import { checkAnswerCache } from "./v2/persistence";
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

  // Semantic cache: if we've answered a near-duplicate query recently, serve
  // it directly and skip the entire pipeline. Only for answer-bearing
  // (scrape) requests.
  if (scrapeOptions && config.DEEPINFRA_API_KEY) {
    const cached = await checkAnswerCache(query, logger);
    if (cached) {
      logger.info("Answer cache hit; skipping pipeline", { query });
      return {
        response: { answer: cached },
        totalResultsCount: 0,
        searchCredits: 0,
        scrapeCredits: 0,
        totalCredits: 0,
        shouldScrape: false,
      };
    }
  }
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

  // Rerank needs a real candidate pool to be meaningful -- floor at 30 so even
  // small limit requests rerank a broad set, then slice takes the top_k.
  const RERANK_MIN_CANDIDATES = 30;
  const num_results_buffer = Math.max(Math.floor(limit * 2), RERANK_MIN_CANDIDATES);

  // Lightweight per-stage observability: ms since the previous mark + a count.
  let __last = Date.now();
  const __mark = (stage: string, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    const ms = now - __last;
    __last = now;
    logger.info(
      `pipeline.stage ${stage} ${ms}ms ${JSON.stringify(extra)}`,
    );
  };

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
  __mark("search", { candidates: searchResponse.web?.length ?? 0 });

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

    // Always-on rerank: score the full candidate pool against the query, then
    // the slice below keeps the most relevant top-`limit`. Best-effort ordering
    // -- on any reranker failure the SearXNG order is kept (see reranker.ts).
    searchResponse.web = await rerankWebResults(query, searchResponse.web, logger);
  }
  __mark("rerank", { web: searchResponse.web?.length ?? 0 });

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
  __mark("slice", { web: searchResponse.web?.length ?? 0 });

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

  let retrievalSufficient = true;
  if (shouldScrape) {
  __mark("pre_sufficiency");
    retrievalSufficient = await checkSufficiency(
      query,
      buildSnippets(searchResponse.web ?? []),
      logger,
    );
    if (!retrievalSufficient) {
      searchResponse.answer = {
        text: "The retrieved context does not contain sufficient information to answer this query.",
        faithfulness: 0,
        grounded: false,
        reason: "insufficient_context",
      };
    }
  }

  if (shouldScrape && scrapeOptions && retrievalSufficient) {
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
      __mark("scrape", { scraped: itemsToScrape.length });

      // RAG: chunk each scraped page, embed via DeepInfra bge-m3, and attach the
      // top-k passages most relevant to the query. Best-effort (see rag.ts).
      await attachRagPassages(searchResponse, query, logger);
      __mark("rag");

      // Grounded answer: synthesize one answer to the query from the scraped
      // pages via GLM-5.2 (ZAI Coding Plan), then HHEM-verify it. Best-effort.
      await buildGroundedAnswer(searchResponse, query, logger);
      __mark("grounded_answer");
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
