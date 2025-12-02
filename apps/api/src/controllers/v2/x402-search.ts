import { Response } from "express";
import {
  Document,
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
  ScrapeOptions,
  TeamFlags,
} from "./types";
import { v7 as uuidv7 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { logJob } from "../../services/logging/log_job";
import { search } from "../../search/v2";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import * as Sentry from "@sentry/node";
import { logger as _logger } from "../../lib/logger";
import type { Logger } from "winston";
import { getJobPriority } from "../../lib/job-priority";
import { CostTracking } from "../../lib/cost-tracking";
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

interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

interface ScrapeJobInput {
  url: string;
  title: string;
  description: string;
}

async function startX420ScrapeJob(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    bypassBilling?: boolean;
    apiKeyId: number | null;
  },
  logger: Logger,
  flags: TeamFlags,
  directToBullMQ: boolean = false,
  isSearchPreview: boolean = false,
): Promise<string> {
  const jobId = uuidv7();

  const zeroDataRetention = flags?.forceZDR ?? false;

  logger.info("Adding scrape job [x402]", {
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
        bypassBilling: true,
        zeroDataRetention,
      },
      origin: options.origin,
      // Do not touch this flag
      is_scrape: false,
      startTime: Date.now(),
      zeroDataRetention,
      apiKeyId: options.apiKeyId,
    },
    jobId,
    jobPriority,
    directToBullMQ,
    true,
  );

  return jobId;
}

async function scrapeX420SearchResult(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    bypassBilling?: boolean;
    apiKeyId: number | null;
  },
  logger: Logger,
  flags: TeamFlags,
  directToBullMQ: boolean = false,
  isSearchPreview: boolean = false,
): Promise<DocumentWithCostTracking> {
  try {
    // Start the scrape job
    const jobId = await startX420ScrapeJob(
      searchResult,
      options,
      logger,
      flags,
      directToBullMQ,
      isSearchPreview,
    );

    const doc: Document = await waitForJob(jobId, options.timeout, false);

    logger.info("Scrape job completed [x402]", {
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
    if (process.env.USE_DB_AUTHENTICATION === "true") {
      const { data: costTrackingResponse, error: costTrackingError } =
        await supabase_service
          .from("firecrawl_jobs")
          .select("cost_tracking")
          .eq("job_id", jobId);

      if (costTrackingError) {
        logger.error("Error getting cost tracking [x402]", {
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
    logger.error(`Error in scrapeSearchResult [x402]: ${error}`, {
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

export async function x402SearchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  const jobId = uuidv7();
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "x402SearchController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on search. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const startTime = new Date().getTime();
  const isSearchPreview =
    process.env.SEARCH_PREVIEW_TOKEN !== undefined &&
    process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  let credits_billed = 0;

  try {
    req.body = searchRequestSchema.parse(req.body);

    // IMPORTANT NOTE: Force results to be at most 10 even if a larger limit is requested
    const MAX_RESULTS = 10;
    if (req.body.limit > MAX_RESULTS) {
      req.body.limit = MAX_RESULTS;
    }

    logger = logger.child({
      query: req.body.query,
      origin: req.body.origin,
    });

    let limit = req.body.limit;

    // Buffer results by 50% to account for filtered URLs
    const num_results_buffer = Math.floor(limit * 2);

    logger.info("Searching for results [x402]");

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
      req.body.scrapeOptions.formats &&
      req.body.scrapeOptions.formats.length > 0;
    const isAsyncScraping = req.body.asyncScraping && shouldScrape;

    if (!shouldScrape) {
      // No scraping - just count results for billing
      credits_billed = totalResultsCount;
    } else {
      // Common setup for both async and sync scraping
      logger.info(
        `Starting ${isAsyncScraping ? "async" : "sync"} search scraping [x402]`,
      );

      // Create common options
      const scrapeOptions = {
        teamId: req.auth.team_id,
        origin: req.body.origin,
        timeout: req.body.timeout,
        scrapeOptions: req.body.scrapeOptions,
        bypassBilling: true, // Async mode bills per job, sync mode bills manually
        apiKeyId: req.acuc?.api_key_id ?? null,
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
            logger.info(`Skipping blocked URL [x402]: ${item.url}`);
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
              logger.info(`Skipping blocked URL [x402]: ${item.url}`);
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
              logger.info(`Skipping blocked URL [x402]: ${item.url}`);
            }
          });
      }

      // Create all promises based on mode (async vs sync)
      const allPromises = itemsToScrape.map(({ scrapeInput }) =>
        isAsyncScraping
          ? startX420ScrapeJob(
              scrapeInput,
              scrapeOptions,
              logger,
              req.acuc?.flags ?? null,
              directToBullMQ,
              isSearchPreview,
            )
          : scrapeX420SearchResult(
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

        // Don't bill here - let each job bill itself when it completes
        credits_billed = 0; // Just for reporting, not billing

        const endTime = new Date().getTime();
        const timeTakenInSeconds = (endTime - startTime) / 1000;

        logger.info("Logging job (async scraping) [x402]", {
          num_docs: credits_billed,
          time_taken: timeTakenInSeconds,
          scrapeIds,
        });

        logJob(
          {
            job_id: jobId,
            success: true,
            num_docs:
              (searchResponse.web?.length ?? 0) +
              (searchResponse.images?.length ?? 0) +
              (searchResponse.news?.length ?? 0),
            docs: [searchResponse],
            time_taken: timeTakenInSeconds,
            team_id: req.auth.team_id,
            mode: "search",
            url: req.body.query,
            scrapeOptions: req.body.scrapeOptions,
            crawlerOptions: {
              ...req.body,
              query: undefined,
              scrapeOptions: undefined,
            },
            origin: req.body.origin,
            integration: req.body.integration,
            credits_billed,
            zeroDataRetention: false,
          },
          false,
          isSearchPreview,
        );

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

        // Update response with scraped data
        Object.assign(searchResponse, scrapedResponse);
      }
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - startTime) / 1000;

    logger.info("Logging job [x402]", {
      num_docs: credits_billed,
      time_taken: timeTakenInSeconds,
    });

    logJob(
      {
        job_id: jobId,
        success: true,
        num_docs:
          (searchResponse.web?.length ?? 0) +
          (searchResponse.images?.length ?? 0) +
          (searchResponse.news?.length ?? 0),
        docs: [searchResponse],
        time_taken: timeTakenInSeconds,
        team_id: req.auth.team_id,
        mode: "search",
        url: req.body.query,
        scrapeOptions: req.body.scrapeOptions,
        crawlerOptions: {
          ...req.body,
          query: undefined,
          scrapeOptions: undefined,
          asyncScraping: isAsyncScraping,
        },
        origin: req.body.origin,
        integration: req.body.integration,
        credits_billed,
        zeroDataRetention: false, // not supported
      },
      false,
      isSearchPreview,
    );

    // For sync scraping or no scraping, don't include scrapeIds
    return res.status(200).json({
      success: true,
      data: searchResponse,
      creditsUsed: credits_billed,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid request body [x402]", { error: error.errors });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.errors,
      });
    }

    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    Sentry.captureException(error);
    logger.error("Unhandled error occurred in search [x402]", { error });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
