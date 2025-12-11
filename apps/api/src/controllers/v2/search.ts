import { Response } from "express";
import { config } from "../../config";
import {
  Document,
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
  ScrapeOptions,
  TeamFlags,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { v7 as uuidv7 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { logSearch, logRequest } from "../../services/logging/log_job";
import { search } from "../../search/v2";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { logger as _logger } from "../../lib/logger";
import type { Logger } from "winston";
import { getJobPriority } from "../../lib/job-priority";
import { CostTracking } from "../../lib/cost-tracking";
import { calculateCreditsToBeBilled } from "../../lib/scrape-billing";
import { supabase_service } from "../../services/supabase";
import { SearchV2Response } from "../../lib/entities";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
import { z } from "zod";
import {
  buildSearchQuery,
  getCategoryFromUrl,
  CategoryOption,
} from "../../lib/search-query-builder";
import {
  applyZdrScope,
  captureExceptionWithZdrCheck,
} from "../../services/sentry";

interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

interface ScrapeJobInput {
  url: string;
  title: string;
  description: string;
}

async function startScrapeJob(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    bypassBilling?: boolean;
    apiKeyId: number | null;
    zeroDataRetention?: boolean;
    requestId?: string;
  },
  logger: Logger,
  flags: TeamFlags,
  directToBullMQ: boolean = false,
  isSearchPreview: boolean = false,
): Promise<string> {
  const jobId = uuidv7();

  const zeroDataRetention =
    flags?.forceZDR || (options.zeroDataRetention ?? false);

  logger.info("Adding scrape job", {
    scrapeId: jobId,
    url: searchResult.url,
    teamId: options.teamId,
    origin: options.origin,
    zeroDataRetention,
  });

  const jobPriority = await getJobPriority({
    team_id: options.teamId,
    basePriority: 10,
  });

  await addScrapeJob(
    {
      url: searchResult.url,
      mode: "single_urls",
      team_id: options.teamId,
      scrapeOptions: {
        ...options.scrapeOptions,
        // TODO: fix this
        maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
      },
      internalOptions: {
        teamId: options.teamId,
        bypassBilling: options.bypassBilling ?? true,
        zeroDataRetention,
      },
      origin: options.origin,
      // Do not touch this flag
      is_scrape: options.bypassBilling ?? false,
      startTime: Date.now(),
      zeroDataRetention,
      apiKeyId: options.apiKeyId,
      requestId: options.requestId,
    },
    jobId,
    jobPriority,
    directToBullMQ,
    true,
  );

  return jobId;
}

async function scrapeSearchResult(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    bypassBilling?: boolean;
    apiKeyId: number | null;
    zeroDataRetention?: boolean;
    requestId?: string;
  },
  logger: Logger,
  flags: TeamFlags,
  directToBullMQ: boolean = false,
  isSearchPreview: boolean = false,
): Promise<DocumentWithCostTracking> {
  try {
    // Start the scrape job
    const jobId = await startScrapeJob(
      searchResult,
      options,
      logger,
      flags,
      directToBullMQ,
      isSearchPreview,
    );

    const doc: Document = await waitForJob(
      jobId,
      options.timeout,
      options.zeroDataRetention ?? false,
      logger,
    );

    logger.info("Scrape job completed", {
      scrapeId: jobId,
      url: searchResult.url,
      teamId: options.teamId,
      origin: options.origin,
    });

    await scrapeQueue.removeJob(jobId, logger);

    const document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      ...doc,
    };

    let costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
    if (config.USE_DB_AUTHENTICATION) {
      const { data: costTrackingResponse, error: costTrackingError } =
        await supabase_service
          .from("scrapes")
          .select("cost_tracking")
          .eq("id", jobId);

      if (costTrackingError) {
        logger.error("Error getting cost tracking", {
          error: costTrackingError,
        });
        throw costTrackingError;
      }

      costTracking = costTrackingResponse?.[0]?.cost_tracking;
    } else {
      costTracking = new CostTracking().toJSON();
    }

    return {
      document,
      costTracking,
    };
  } catch (error) {
    logger.error(`Error in scrapeSearchResult: ${error}`, {
      url: searchResult.url,
      teamId: options.teamId,
    });

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      metadata: {
        statusCode: 500,
        error: error.message,
        proxyUsed: "basic",
      },
    };

    return {
      document,
      costTracking: new CostTracking().toJSON(),
    };
  }
}

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId = uuidv7();
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "searchController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on search. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview =
    config.SEARCH_PREVIEW_TOKEN !== undefined &&
    config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  let credits_billed = 0;

  let zeroDataRetention = false;

  try {
    req.body = searchRequestSchema.parse(req.body);

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    const isZDR = req.body.enterprise?.includes("zdr");
    const isAnon = req.body.enterprise?.includes("anon");
    const isZDROrAnon = isZDR || isAnon;
    zeroDataRetention = isZDROrAnon ?? false;
    applyZdrScope(isZDROrAnon ?? false);

    await logRequest({
      id: jobId,
      kind: "search",
      api_version: "v2",
      team_id: req.auth.team_id,
      origin: req.body.origin ?? "api",
      integration: req.body.integration,
      target_hint: req.body.query,
      zeroDataRetention: isZDROrAnon ?? false, // not supported for search
      api_key_id: req.acuc?.api_key_id ?? null,
    });

    let limit = req.body.limit;

    // Buffer results by 50% to account for filtered URLs
    const num_results_buffer = Math.floor(limit * 2);

    logger.info("Searching for results");

    // Extract unique types from sources for the search function
    // After transformation, sources is always an array of objects
    const searchTypes = [...new Set(req.body.sources.map((s: any) => s.type))];

    // Build search query with category filters
    const { query: searchQuery, categoryMap } = buildSearchQuery(
      req.body.query,
      req.body.categories as CategoryOption[],
    );

    const searchResponse = (await search({
      query: searchQuery,
      logger,
      advanced: false,
      num_results: num_results_buffer,
      tbs: req.body.tbs,
      filter: req.body.filter,
      lang: req.body.lang,
      country: req.body.country,
      location: req.body.location,
      type: searchTypes,
      enterprise: req.body.enterprise,
    })) as SearchV2Response;

    // Add category labels to web results
    if (searchResponse.web && searchResponse.web.length > 0) {
      searchResponse.web = searchResponse.web.map(result => ({
        ...result,
        category: getCategoryFromUrl(result.url, categoryMap),
      }));
    }

    // Add category labels to news results
    if (searchResponse.news && searchResponse.news.length > 0) {
      searchResponse.news = searchResponse.news.map(result => ({
        ...result,
        category: result.url
          ? getCategoryFromUrl(result.url, categoryMap)
          : undefined,
      }));
    }

    // Apply limit to each result type separately
    let totalResultsCount = 0;

    // Apply limit to web results
    if (searchResponse.web && searchResponse.web.length > 0) {
      if (searchResponse.web.length > limit) {
        searchResponse.web = searchResponse.web.slice(0, limit);
      }
      totalResultsCount += searchResponse.web.length;
    }

    // Apply limit to images
    if (searchResponse.images && searchResponse.images.length > 0) {
      if (searchResponse.images.length > limit) {
        searchResponse.images = searchResponse.images.slice(0, limit);
      }
      totalResultsCount += searchResponse.images.length;
    }

    // Apply limit to news
    if (searchResponse.news && searchResponse.news.length > 0) {
      if (searchResponse.news.length > limit) {
        searchResponse.news = searchResponse.news.slice(0, limit);
      }
      totalResultsCount += searchResponse.news.length;
    }

    // Check if scraping is requested
    const shouldScrape =
      req.body.scrapeOptions?.formats &&
      req.body.scrapeOptions.formats.length > 0;
    const isAsyncScraping = req.body.asyncScraping && shouldScrape;

    if (!shouldScrape) {
      const creditsPerTenResults = isZDR ? 10 : 2;
      credits_billed = Math.ceil(totalResultsCount / 10) * creditsPerTenResults;
    } else {
      // Common setup for both async and sync scraping
      logger.info(
        `Starting ${isAsyncScraping ? "async" : "sync"} search scraping`,
      );

      // Safely extract scrapeOptions with runtime check
      if (!req.body.scrapeOptions) {
        logger.error(
          "scrapeOptions is undefined despite shouldScrape being true",
        );
        return res.status(500).json({
          success: false,
          error: "Internal server error: scrapeOptions is missing",
        });
      }

      const bodyScrapeOptions = req.body.scrapeOptions;

      // Create common options
      const scrapeOptions = {
        teamId: req.auth.team_id,
        origin: req.body.origin,
        timeout: req.body.timeout,
        scrapeOptions: bodyScrapeOptions,
        bypassBilling: !isAsyncScraping, // Async mode bills per job, sync mode bills manually
        apiKeyId: req.acuc?.api_key_id ?? null,
        zeroDataRetention: isZDROrAnon,
        requestId: jobId,
      };

      const directToBullMQ = (req.acuc?.price_credits ?? 0) <= 3000;

      // Prepare all items to scrape with their original data
      const itemsToScrape: Array<{
        item: any;
        type: "web" | "news" | "image";
        scrapeInput: ScrapeJobInput;
      }> = [];

      // Add web results (skip blocked URLs)
      if (searchResponse.web) {
        searchResponse.web.forEach(item => {
          if (!isUrlBlocked(item.url, req.acuc?.flags ?? null)) {
            itemsToScrape.push({
              item,
              type: "web",
              scrapeInput: {
                url: item.url,
                title: item.title,
                description: item.description,
              },
            });
          } else {
            logger.info(`Skipping blocked URL: ${item.url}`);
          }
        });
      }

      // Add news results (only those with URLs and not blocked)
      if (searchResponse.news) {
        searchResponse.news
          .filter(item => item.url)
          .forEach(item => {
            if (!isUrlBlocked(item.url!, req.acuc?.flags ?? null)) {
              itemsToScrape.push({
                item,
                type: "news",
                scrapeInput: {
                  url: item.url!,
                  title: item.title || "",
                  description: item.snippet || "",
                },
              });
            } else {
              logger.info(`Skipping blocked URL: ${item.url}`);
            }
          });
      }

      // Add image results (only those with URLs and not blocked)
      if (searchResponse.images) {
        searchResponse.images
          .filter(item => item.url)
          .forEach(item => {
            if (!isUrlBlocked(item.url!, req.acuc?.flags ?? null)) {
              itemsToScrape.push({
                item,
                type: "image",
                scrapeInput: {
                  url: item.url!,
                  title: item.title || "",
                  description: "",
                },
              });
            } else {
              logger.info(`Skipping blocked URL: ${item.url}`);
            }
          });
      }

      // Create all promises based on mode (async vs sync)
      const allPromises = itemsToScrape.map(({ scrapeInput }) =>
        isAsyncScraping
          ? startScrapeJob(
              scrapeInput,
              scrapeOptions,
              logger,
              req.acuc?.flags ?? null,
              directToBullMQ,
              isSearchPreview,
            )
          : scrapeSearchResult(
              scrapeInput,
              scrapeOptions,
              logger,
              req.acuc?.flags ?? null,
              directToBullMQ,
              isSearchPreview,
            ),
      );

      // Execute all operations in parallel
      const results = await Promise.all(allPromises);

      if (isAsyncScraping) {
        // Async mode: organize job IDs and return immediately
        const allJobIds = results as string[];
        const scrapeIds: {
          web?: string[];
          news?: string[];
          images?: string[];
        } = {};

        // Organize job IDs by type
        const webItems = itemsToScrape.filter(i => i.type === "web");
        const newsItems = itemsToScrape.filter(i => i.type === "news");
        const imageItems = itemsToScrape.filter(i => i.type === "image");

        let currentIndex = 0;

        if (webItems.length > 0) {
          scrapeIds.web = allJobIds.slice(
            currentIndex,
            currentIndex + webItems.length,
          );
          currentIndex += webItems.length;
        }

        if (newsItems.length > 0) {
          scrapeIds.news = allJobIds.slice(
            currentIndex,
            currentIndex + newsItems.length,
          );
          currentIndex += newsItems.length;
        }

        if (imageItems.length > 0) {
          scrapeIds.images = allJobIds.slice(
            currentIndex,
            currentIndex + imageItems.length,
          );
        }

        const creditsPerTenResults = isZDR ? 10 : 2;
        credits_billed =
          Math.ceil(totalResultsCount / 10) * creditsPerTenResults;

        // Bill for search results now (scrape jobs will bill themselves when they complete)
        if (!isSearchPreview) {
          billTeam(
            req.auth.team_id,
            req.acuc?.sub_id ?? undefined,
            credits_billed,
            req.acuc?.api_key_id ?? null,
          ).catch(error => {
            logger.error(
              `Failed to bill team ${req.acuc?.sub_id} for ${credits_billed} credits: ${error}`,
            );
          });
        }

        const endTime = new Date().getTime();
        const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

        logger.info("Logging job (async scraping)", {
          num_docs: credits_billed,
          time_taken: timeTakenInSeconds,
          scrapeIds,
        });

        logSearch(
          {
            id: jobId,
            request_id: jobId,
            query: req.body.query,
            is_successful: true,
            error: undefined,
            results: searchResponse as any,
            num_results: totalResultsCount,
            time_taken: timeTakenInSeconds,
            team_id: req.auth.team_id,
            options: req.body,
            credits_cost: credits_billed,
            zeroDataRetention: isZDROrAnon ?? false,
          },
          false,
        );

        // Log final timing information for async mode
        const totalRequestTime = new Date().getTime() - middlewareStartTime;
        const controllerTime = new Date().getTime() - controllerStartTime;
        logger.info("Search completed successfully (async)", {
          version: "v2",
          jobId,
          middlewareStartTime,
          controllerStartTime,
          middlewareTime,
          controllerTime,
          totalRequestTime,
          creditsUsed: credits_billed,
          scrapeful: shouldScrape,
        });

        return res.status(200).json({
          success: true,
          data: searchResponse,
          scrapeIds,
          creditsUsed: credits_billed,
        });
      } else {
        // Sync mode: process scraped documents
        const allDocsWithCostTracking = results as DocumentWithCostTracking[];
        const scrapedResponse: SearchV2Response = {};

        // Create a map of results indexed by URL for easy lookup
        const resultsMap = new Map<string, Document>();
        itemsToScrape.forEach((item, index) => {
          resultsMap.set(
            item.scrapeInput.url,
            allDocsWithCostTracking[index].document,
          );
        });

        // Process web results - preserve all original fields and add scraped content
        if (searchResponse.web && searchResponse.web.length > 0) {
          scrapedResponse.web = searchResponse.web.map(item => {
            const doc = resultsMap.get(item.url);
            return {
              ...item, // Preserve ALL original fields
              ...doc, // Override/add scraped content
            };
          });
        }

        // Process news results - preserve all original fields and add scraped content
        if (searchResponse.news && searchResponse.news.length > 0) {
          scrapedResponse.news = searchResponse.news.map(item => {
            const doc = item.url ? resultsMap.get(item.url) : undefined;
            return {
              ...item, // Preserve ALL original fields
              ...doc, // Override/add scraped content
            };
          });
        }

        // Process image results - preserve all original fields and add scraped content
        if (searchResponse.images && searchResponse.images.length > 0) {
          scrapedResponse.images = searchResponse.images.map(item => {
            const doc = item.url ? resultsMap.get(item.url) : undefined;
            return {
              ...item, // Preserve ALL original fields
              ...doc, // Override/add scraped content
            };
          });
        }

        // Calculate credits
        // bodyScrapeOptions is guaranteed to exist here because we're in the shouldScrape block
        const creditPromises = allDocsWithCostTracking.map(
          async docWithCost => {
            return await calculateCreditsToBeBilled(
              bodyScrapeOptions,
              {
                teamId: req.auth.team_id,
                bypassBilling: true,
                zeroDataRetention: isZDROrAnon,
              },
              docWithCost.document,
              docWithCost.costTracking,
              req.acuc?.flags ?? null,
            );
          },
        );

        try {
          const individualCredits = await Promise.all(creditPromises);
          const scrapeCredits = individualCredits.reduce(
            (sum, credit) => sum + credit,
            0,
          );

          const creditsPerTenResults = isZDR ? 10 : 2;
          const searchCredits =
            Math.ceil(totalResultsCount / 10) * creditsPerTenResults;

          credits_billed = scrapeCredits + searchCredits;
        } catch (error) {
          logger.error("Error calculating credits for billing", { error });
          credits_billed = totalResultsCount;
        }

        // Update response with scraped data
        Object.assign(searchResponse, scrapedResponse);
      }
    }

    // Bill team once for all successful results
    // - For sync scraping: Bill based on actual scraped content
    // - For async scraping: Jobs handle their own billing
    // - For no scraping: Bill based on search results count
    if (
      !isSearchPreview &&
      (!shouldScrape || (shouldScrape && !isAsyncScraping))
    ) {
      billTeam(
        req.auth.team_id,
        req.acuc?.sub_id ?? undefined,
        credits_billed,
        req.acuc?.api_key_id ?? null,
      ).catch(error => {
        logger.error(
          `Failed to bill team ${req.acuc?.sub_id} for ${credits_billed} credits: ${error}`,
        );
      });
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    logger.info("Logging job", {
      num_docs: credits_billed,
      time_taken: timeTakenInSeconds,
    });

    logSearch(
      {
        id: jobId,
        request_id: jobId,
        query: req.body.query,
        is_successful: true,
        error: undefined,
        results: searchResponse as any,
        num_results: totalResultsCount,
        time_taken: timeTakenInSeconds,
        team_id: req.auth.team_id,
        options: req.body,
        credits_cost: credits_billed,
        zeroDataRetention: isZDROrAnon ?? false, // not supported
      },
      false,
    );

    // Log final timing information
    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;

    logger.info("Request metrics", {
      version: "v2",
      jobId,
      mode: "search",
      middlewareStartTime,
      controllerStartTime,
      middlewareTime,
      controllerTime,
      totalRequestTime,
      creditsUsed: credits_billed,
      scrapeful: shouldScrape,
    });

    // For sync scraping or no scraping, don't include scrapeIds
    return res.status(200).json({
      success: true,
      data: searchResponse,
      creditsUsed: credits_billed,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid request body", { error: error.issues });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
      });
    }

    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    captureExceptionWithZdrCheck(error, {
      extra: { zeroDataRetention },
    });
    logger.error("Unhandled error occurred in search", {
      version: "v2",
      error,
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
