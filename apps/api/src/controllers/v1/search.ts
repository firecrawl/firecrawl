import { Response } from "express";
import { config } from "../../config";
import {
  Document,
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { v7 as uuidv7 } from "uuid";
import { logSearch, logRequest } from "../../services/logging/log_job";
import { search } from "../../search";
import { logger as _logger } from "../../lib/logger";
import type { Logger } from "winston";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import { z } from "zod";
import { executeSearch } from "../../search/execute";
import {
  DocumentWithCostTracking,
  scrapeSearchResults,
} from "../../search/scrape";
import {
  transformToV1Response,
  filterDocumentsWithContent,
} from "../../search/transform";
import { fromV1ScrapeOptions } from "../v2/types";

// Used for deep research
export async function searchAndScrapeSearchResult(
  query: string,
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: any;
    apiKeyId: number | null;
    requestId?: string;
  },
  logger: Logger,
  flags: any,
): Promise<DocumentWithCostTracking[]> {
  try {
    const searchResults = await search({
      query,
      logger,
      num_results: 5,
    });

    const { scrapeOptions } = fromV1ScrapeOptions(
      options.scrapeOptions,
      options.timeout,
      options.teamId,
    );

    return await scrapeSearchResults(
      searchResults.map(r => ({
        url: r.url,
        title: r.title,
        description: r.description,
      })),
      {
        teamId: options.teamId,
        origin: options.origin,
        timeout: options.timeout,
        scrapeOptions,
        apiKeyId: options.apiKeyId,
        requestId: options.requestId,
      },
      logger,
      flags,
    );
  } catch (error) {
    return [];
  }
}

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
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
    id: jobId,
  };
  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview =
    config.SEARCH_PREVIEW_TOKEN !== undefined &&
    config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  try {
    req.body = searchRequestSchema.parse(req.body);

    logger = logger.child({
      version: "v1",
      query: req.body.query,
      origin: req.body.origin,
    });

    await logRequest({
      id: jobId,
      kind: "search",
      api_version: "v1",
      team_id: req.auth.team_id,
      origin: req.body.origin ?? "api",
      integration: req.body.integration,
      target_hint: req.body.query,
      zeroDataRetention: false,
      api_key_id: req.acuc?.api_key_id ?? null,
    });

    // Convert v1 scrape options to v2 format
    const { scrapeOptions } = fromV1ScrapeOptions(
      req.body.scrapeOptions,
      req.body.timeout,
      req.auth.team_id,
    );

    // Check if scraping is requested
    const shouldScrape =
      req.body.scrapeOptions.formats &&
      req.body.scrapeOptions.formats.length > 0;

    // Execute search using v2 logic
    const result = await executeSearch(
      {
        query: req.body.query,
        limit: req.body.limit,
        tbs: req.body.tbs,
        filter: req.body.filter,
        lang: req.body.lang,
        country: req.body.country,
        location: req.body.location,
        sources: [{ type: "web" }], // v1 only supports web
        scrapeOptions: shouldScrape ? scrapeOptions : undefined,
        timeout: req.body.timeout,
      },
      {
        teamId: req.auth.team_id,
        origin: req.body.origin,
        apiKeyId: req.acuc?.api_key_id ?? null,
        flags: req.acuc?.flags ?? null,
        requestId: jobId,
        bypassBilling: false,
        zeroDataRetention: false,
      },
      logger,
    );

    // Transform v2 response to v1 format (flat array)
    const docs = transformToV1Response(result.response);

    if (docs.length === 0) {
      logger.info("No search results found");
      responseData.warning = "No search results found";
    } else if (shouldScrape) {
      // Filter documents that have content
      const filteredDocs = filterDocumentsWithContent(docs);

      if (filteredDocs.length === 0) {
        responseData.data = docs;
        responseData.warning = "No content found in search results";
      } else {
        responseData.data = filteredDocs;
      }
    } else {
      // No scraping - just return basic info
      responseData.data = docs.map(d => ({
        url: d.url,
        title: d.title,
        description: d.description,
      })) as Document[];
    }

    // Bill team for search credits only
    if (!isSearchPreview) {
      billTeam(
        req.auth.team_id,
        req.acuc?.sub_id ?? undefined,
        result.searchCredits,
        req.acuc?.api_key_id ?? null,
      ).catch(error => {
        logger.error(
          `Failed to bill team ${req.auth.team_id} for ${result.searchCredits} credits: ${error}`,
        );
      });
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    logSearch(
      {
        id: jobId,
        request_id: jobId,
        query: req.body.query,
        is_successful: true,
        error: undefined,
        results: responseData.data,
        num_results: responseData.data.length,
        time_taken: timeTakenInSeconds,
        team_id: req.auth.team_id,
        options: {
          ...req.body,
          query: undefined,
          scrapeOptions: undefined,
        },
        credits_cost: result.searchCredits,
        zeroDataRetention: false,
      },
      false,
    );

    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;

    logger.info("Request metrics", {
      version: "v1",
      mode: "search",
      jobId,
      middlewareStartTime,
      controllerStartTime,
      middlewareTime,
      controllerTime,
      totalRequestTime,
      creditsUsed: result.searchCredits,
      scrapeful: shouldScrape,
    });

    return res.status(200).json(responseData);
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
      extra: { zeroDataRetention: false },
    });
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
