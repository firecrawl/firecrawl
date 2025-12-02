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
import { billTeam } from "../../services/billing/credit_billing";
import { v7 as uuidv7 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { logJob } from "../../services/logging/log_job";
import { search } from "../../search";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import * as Sentry from "@sentry/node";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { logger as _logger } from "../../lib/logger";
import type { Logger } from "winston";
import { getJobPriority } from "../../lib/job-priority";
import { CostTracking } from "../../lib/cost-tracking";
import { calculateCreditsToBeBilled } from "../../lib/scrape-billing";
import { supabase_service } from "../../services/supabase";
import { fromV1ScrapeOptions } from "../v2/types";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";

interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

// Used for deep research
export async function searchAndScrapeSearchResult(
  query: string,
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    apiKeyId: number | null;
  },
  logger: Logger,
  flags: TeamFlags,
): Promise<DocumentWithCostTracking[]> {
  try {
    const searchResults = await search({
      query,
      logger,
      num_results: 5,
    });

    const documentsWithCostTracking = await Promise.all(
      searchResults.map(result =>
        scrapeSearchResult(
          {
            url: result.url,
            title: result.title,
            description: result.description,
          },
          options,
          logger,
          flags,
        ),
      ),
    );

    return documentsWithCostTracking;
  } catch (error) {
    return [];
  }
}

async function scrapeSearchResult(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    apiKeyId: number | null;
  },
  logger: Logger,
  flags: TeamFlags,
  directToBullMQ: boolean = false,
  isSearchPreview: boolean = false,
): Promise<DocumentWithCostTracking> {
  const jobId = uuidv7();

  const costTracking = new CostTracking();

  const zeroDataRetention = flags?.forceZDR ?? false;

  try {
    if (isUrlBlocked(searchResult.url, flags)) {
      throw new Error("Could not scrape url: " + BLOCKLISTED_URL_MESSAGE);
    }
    logger.info("Adding scrape job", {
      scrapeId: jobId,
      url: searchResult.url,
      teamId: options.teamId,
      origin: options.origin,
      zeroDataRetention,
    });

    const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
      options.scrapeOptions,
      options.timeout,
      options.teamId,
    );

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
          ...scrapeOptions,
          maxAge:
            scrapeOptions.maxAge === 0
              ? 3 * 24 * 60 * 60 * 1000
              : scrapeOptions.maxAge,
        },
        internalOptions: {
          ...internalOptions,
          teamId: options.teamId,
          bypassBilling: true,
          zeroDataRetention,
        },
        origin: options.origin,
        is_scrape: true,
        startTime: Date.now(),
        zeroDataRetention,
        apiKeyId: options.apiKeyId,
      },
      jobId,
      jobPriority,
      directToBullMQ,
      true,
    );

    const doc: Document = await waitForJob(
      jobId,
      options.timeout,
      zeroDataRetention,
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
    if (process.env.USE_DB_AUTHENTICATION === "true") {
      const { data: costTrackingResponse, error: costTrackingError } =
        await supabase_service
          .from("firecrawl_jobs")
          .select("cost_tracking")
          .eq("job_id", jobId);

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
      scrapeId: jobId,
      url: searchResult.url,
      teamId: options.teamId,
    });

    let statusCode = 0;
    if (error?.message?.includes("Could not scrape url")) {
      statusCode = 403;
    }

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      metadata: {
        statusCode,
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
    module: "search",
    method: "searchController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
    searchQuery: req.body.query.slice(0, 100),
  });

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on search. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  let responseData: SearchResponse = {
    success: true,
    data: [],
  };
  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview =
    process.env.SEARCH_PREVIEW_TOKEN !== undefined &&
    process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  let credits_billed = 0;
  let allDocsWithCostTracking: DocumentWithCostTracking[] = [];

  try {
    req.body = searchRequestSchema.parse(req.body);

    logger = logger.child({
      version: "v1",
      query: req.body.query,
      origin: req.body.origin,
    });

    let limit = req.body.limit;

    // Buffer results by 50% to account for filtered URLs
    const num_results_buffer = Math.floor(limit * 2);

    logger.info("Searching for results");

    let searchResults = await search({
      query: req.body.query,
      logger,
      advanced: false,
      num_results: num_results_buffer,
      tbs: req.body.tbs,
      filter: req.body.filter,
      lang: req.body.lang,
      country: req.body.country,
      location: req.body.location,
    });

    if (req.body.ignoreInvalidURLs) {
      searchResults = searchResults.filter(
        result => !isUrlBlocked(result.url, req.acuc?.flags ?? null),
      );
    }

    logger.info("Searching completed", {
      num_results: searchResults.length,
    });

    // Filter blocked URLs early to avoid unnecessary billing
    if (searchResults.length > limit) {
      searchResults = searchResults.slice(0, limit);
    }

    if (searchResults.length === 0) {
      logger.info("No search results found");
      responseData.warning = "No search results found";
    } else if (
      !req.body.scrapeOptions.formats ||
      req.body.scrapeOptions.formats.length === 0
    ) {
      responseData.data = searchResults.map(r => ({
        url: r.url,
        title: r.title,
        description: r.description,
      })) as Document[];
      credits_billed = Math.ceil(responseData.data.length / 10) * 2;
    } else {
      logger.info("Scraping search results");
      const scrapePromises = searchResults.map(result =>
        scrapeSearchResult(
          result,
          {
            teamId: req.auth.team_id,
            origin: req.body.origin,
            timeout: req.body.timeout,
            scrapeOptions: req.body.scrapeOptions,
            apiKeyId: req.acuc?.api_key_id ?? null,
          },
          logger,
          req.acuc?.flags ?? null,
          (req.acuc?.price_credits ?? 0) <= 3000,
          isSearchPreview,
        ),
      );

      const docsWithCostTracking = await Promise.all(scrapePromises);
      logger.info("Scraping completed", {
        num_docs: docsWithCostTracking.length,
      });

      const docs = docsWithCostTracking.map(item => item.document);
      const filteredDocs = docs.filter(
        doc =>
          doc.serpResults || (doc.markdown && doc.markdown.trim().length > 0),
      );

      logger.info("Filtering completed", {
        num_docs: filteredDocs.length,
      });

      if (filteredDocs.length === 0) {
        responseData.data = docs;
        responseData.warning = "No content found in search results";
      } else {
        responseData.data = filteredDocs;
      }

      const finalDocsForBilling = responseData.data;

      const creditPromises = finalDocsForBilling.map(async finalDoc => {
        const matchingDocWithCost = docsWithCostTracking.find(
          item =>
            item.document.metadata &&
            finalDoc.metadata &&
            item.document.metadata.scrapeId === finalDoc.metadata.scrapeId,
        );

        if (matchingDocWithCost) {
          const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(
            req.body.scrapeOptions,
            req.body.timeout,
            req.auth.team_id,
          );
          return await calculateCreditsToBeBilled(
            scrapeOptions,
            {
              ...internalOptions,
              teamId: req.auth.team_id,
              bypassBilling: true,
              zeroDataRetention: false,
            },
            matchingDocWithCost.document,
            matchingDocWithCost.costTracking,
            req.acuc?.flags ?? null,
          );
        } else {
          return 1;
        }
      });

      try {
        const individualCredits = await Promise.all(creditPromises);
        credits_billed = individualCredits.reduce(
          (sum, credit) => sum + credit,
          0,
        );
      } catch (error) {
        logger.error("Error calculating credits for billing", { error });
        credits_billed = responseData.data.length;
      }

      allDocsWithCostTracking = docsWithCostTracking;
    }

    // Bill team once for all successful results
    if (!isSearchPreview) {
      billTeam(
        req.auth.team_id,
        req.acuc?.sub_id ?? undefined,
        credits_billed,
        req.acuc?.api_key_id ?? null,
      ).catch(error => {
        logger.error(
          `Failed to bill team ${req.auth.team_id} for ${responseData.data.length} credits: ${error}`,
        );
      });
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    logger.info("Logging job", {
      num_docs: responseData.data.length,
      time_taken: timeTakenInSeconds,
    });

    logJob(
      {
        job_id: jobId,
        success: true,
        num_docs: responseData.data.length,
        docs: responseData.data,
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
        zeroDataRetention: false, // not supported
      },
      false,
      isSearchPreview,
    );

    // Log final timing information
    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;
    const scrapeful = !!(
      req.body.scrapeOptions.formats &&
      req.body.scrapeOptions.formats.length > 0
    );
    logger.info("Request metrics", {
      version: "v1",
      mode: "search",
      jobId,
      middlewareStartTime,
      controllerStartTime,
      middlewareTime,
      controllerTime,
      totalRequestTime,
      creditsUsed: credits_billed,
      scrapeful,
    });

    return res.status(200).json(responseData);
  } catch (error) {
    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    Sentry.captureException(error);
    logger.error("Unhandled error occurred in search", {
      version: "v1",
      error,
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
