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
import type { BillingMetadata } from "../services/billing/types";
import {
  generateCompletions,
  GenerateCompletionsOptions,
} from "../scraper/scrapeURL/transformers/llmExtract";
import { CostTracking } from "../lib/cost-tracking";
import { getModel } from "../lib/generic-ai";

interface ExtractOptions {
  prompt: string;
  schema?: any;
}

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
  extract?: ExtractOptions;
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
  billing?: BillingMetadata;
  agentIndexOnly?: boolean;
}

interface SearchExecuteResult {
  response: SearchV2Response;
  totalResultsCount: number;
  searchCredits: number;
  scrapeCredits: number;
  totalCredits: number;
  shouldScrape: boolean;
  extract?: any;
  extractWarning?: string;
}

export async function executeSearch(
  options: SearchOptions,
  context: SearchContext,
  logger: Logger,
): Promise<SearchExecuteResult> {
  const { query, limit, sources, categories, scrapeOptions, extract } = options;
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

  // When extract is requested, ensure markdown is available for LLM input
  const hasMarkdownFormat = scrapeOptions?.formats?.some(
    f => f.type === "markdown",
  );
  const needsMarkdownForExtract = extract && !hasMarkdownFormat;

  const shouldScrape =
    (scrapeOptions?.formats && scrapeOptions.formats.length > 0) ||
    needsMarkdownForExtract;

  if (shouldScrape) {
    // Ensure markdown format is included when extract is requested
    const effectiveScrapeOptions: ScrapeOptions = needsMarkdownForExtract
      ? {
          ...(scrapeOptions ?? {
            onlyMainContent: true,
            onlyCleanContent: false,
            waitFor: 0,
            mobile: false,
            removeBase64Images: true,
            fastMode: false,
            blockAds: true,
            proxy: "auto" as const,
            storeInCache: true,
            __experimental_omce: false,
            __experimental_engpicker: false,
          }),
          formats: [
            ...(scrapeOptions?.formats ?? []),
            { type: "markdown" as const },
          ],
        }
      : scrapeOptions!;
    const itemsToScrape = getItemsToScrape(searchResponse, flags);

    if (itemsToScrape.length > 0) {
      const scrapeOpts = {
        teamId,
        origin,
        timeout: options.timeout,
        scrapeOptions: effectiveScrapeOptions,
        bypassBilling: bypassBilling ?? false,
        apiKeyId,
        zeroDataRetention,
        requestId,
        billing,
        agentIndexOnly: context.agentIndexOnly,
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

  // Consolidated extraction across all results
  let extractResult: any = undefined;
  let extractWarning: string | undefined = undefined;
  if (extract) {
    const allMarkdown = collectMarkdownFromResults(searchResponse);

    if (allMarkdown.length > 0) {
      try {
        const costTracking = new CostTracking();
        const generationOptions: GenerateCompletionsOptions = {
          logger: logger.child({
            method: "executeSearch/consolidatedExtract",
          }),
          options: {
            prompt: extract.prompt,
            schema: extract.schema,
          },
          markdown: allMarkdown,
          model: getModel("gpt-4o-mini", "openai"),
          retryModel: getModel("gpt-4.1", "openai"),
          costTrackingOptions: {
            costTracking,
            metadata: {
              module: "search",
              method: "consolidatedExtract",
            },
          },
          metadata: {
            teamId,
            functionId: "searchConsolidatedExtract",
            scrapeId: requestId,
          },
        };

        const completionResult = await generateCompletions(generationOptions);
        extractResult = completionResult.extract;
        extractWarning = completionResult.warning;
      } catch (error: unknown) {
        logger.error("Consolidated extract failed", { error });
        const message = error instanceof Error ? error.message : String(error);
        extractWarning = `Consolidated extraction failed: ${message}`;
      }
    } else {
      extractWarning =
        "No content available for extraction. Ensure search results have markdown content by including scrapeOptions with formats.";
    }
  }

  return {
    response: searchResponse,
    totalResultsCount,
    searchCredits,
    scrapeCredits,
    totalCredits: searchCredits + scrapeCredits,
    shouldScrape: shouldScrape ?? false,
    extract: extractResult,
    extractWarning,
  };
}

/**
 * Collect markdown content from all search results into a single combined string.
 * Each result's markdown is prefixed with its source URL for context.
 */
function collectMarkdownFromResults(response: SearchV2Response): string {
  const parts: string[] = [];

  if (response.web) {
    for (const item of response.web) {
      if (item.markdown) {
        parts.push(
          `--- Source: ${item.url} (${item.title}) ---\n${item.markdown}`,
        );
      }
    }
  }

  if (response.news) {
    for (const item of response.news) {
      if (item.markdown) {
        parts.push(
          `--- Source: ${item.url ?? "unknown"} (${item.title ?? ""}) ---\n${item.markdown}`,
        );
      }
    }
  }

  return parts.join("\n\n");
}
