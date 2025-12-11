import { supabase_service } from "../supabase";
import { config } from "../../config";
import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { configDotenv } from "dotenv";
import * as Sentry from "@sentry/node";
import {
  saveDeepResearchToGCS,
  saveExtractToGCS,
  saveLlmsTxtToGCS,
  saveMapToGCS,
  saveScrapeToGCS,
  saveSearchToGCS,
} from "../../lib/gcs-jobs";
import { hasFormatOfType } from "../../lib/format-utils";
import type { Document, ScrapeOptions } from "../../controllers/v2/types";
import type { CostTracking } from "../../lib/cost-tracking";
import type { Logger } from "winston";
configDotenv();

const previewTeamId = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

/**
 * Sanitize string fields by removing null bytes (\u0000)
 * PostgreSQL doesn't allow null bytes in text fields
 * This can come from user-provided data like URLs, origin, integration fields
 */
function sanitizeString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  return value.replace(/\u0000/g, "");
}

async function robustInsert(
  table: string,
  data: any,
  force: boolean,
  logger: Logger,
) {
  if (config.USE_DB_AUTHENTICATION !== true) {
    logger.info(
      "Skipping database insertion due to USE_DB_AUTHENTICATION being off",
      { table },
    );
    return;
  }

  if (force) {
    let i = 0,
      done = false;
    let lastError: any = null;
    while (i++ <= 10) {
      try {
        const { error } = await supabase_service.from(table).insert(data);
        if (error) {
          lastError = error;
          logger.error(
            "Error inserting into database due to Supabase error, trying again",
            { error, table, attempt: i },
          );
          await new Promise(resolve => setTimeout(resolve, 75));
        } else {
          done = true;
          break;
        }
      } catch (error) {
        lastError = error;
        logger.error(
          "Error inserting into database due to unknown error, trying again",
          { error, table, attempt: i },
        );
        await new Promise(resolve => setTimeout(resolve, 75));
      }
    }

    if (done) {
      logger.info("Inserted into database successfully", { table });
    } else {
      logger.error("Failed to insert into database after 10 attempts", {
        table,
        lastError,
      });
      // Report to Sentry with context
      Sentry.captureException(
        lastError || new Error("Database insert failed after 10 attempts"),
        {
          tags: {
            table,
            operation: "robustInsert",
          },
          extra: {
            table,
            data: JSON.stringify(data).substring(0, 500), // Limit size
            attempts: 10,
            lastError: lastError ? JSON.stringify(lastError) : null,
          },
        },
      );
    }
  } else {
    try {
      const { error } = await supabase_service.from(table).insert(data);
      if (error) {
        logger.error("Error inserting into database due to Supabase error", {
          error,
          table,
        });
        // Report to Sentry
        Sentry.captureException(error, {
          tags: {
            table,
            operation: "robustInsert",
            force: "false",
          },
          extra: {
            table,
            error: JSON.stringify(error),
            data: JSON.stringify(data).substring(0, 500), // Limit size
          },
        });
      } else {
        logger.info("Inserted into database successfully", { table });
      }
    } catch (error) {
      logger.error("Error inserting into database due to unknown error", {
        error,
        table,
      });
      // Report to Sentry
      Sentry.captureException(error, {
        tags: {
          table,
          operation: "robustInsert",
          force: "false",
        },
        extra: {
          table,
          data: JSON.stringify(data).substring(0, 500), // Limit size
        },
      });
    }
  }
}

type LoggedRequest = {
  id: string;
  kind:
    | "scrape"
    | "crawl"
    | "batch_scrape"
    | "search"
    | "extract"
    | "llmstxt"
    | "deep_research"
    | "map";
  api_version: string;
  team_id: string;
  origin?: string;
  integration?: string | null;
  target_hint: string;
  zeroDataRetention: boolean;
  api_key_id?: number | null;
};

export async function logRequest(request: LoggedRequest) {
  const logger = _logger.child({
    module: "log_job",
    method: "logRequest",
    requestId: request.id,
    teamId: request.team_id,
    zeroDataRetention: request.zeroDataRetention,
  });

  // Sanitize user-provided fields (most likely sources of null bytes)
  const sanitizedOrigin = sanitizeString(request.origin);
  const sanitizedIntegration = sanitizeString(request.integration ?? null);
  const sanitizedTargetHint = request.zeroDataRetention
    ? "<redacted due to zero data retention>"
    : sanitizeString(request.target_hint);

  await robustInsert(
    "requests",
    {
      id: request.id,
      kind: request.kind,
      api_version: request.api_version,
      team_id:
        request.team_id === "preview" || request.team_id?.startsWith("preview_")
          ? previewTeamId
          : request.team_id,
      origin: sanitizedOrigin,
      integration: sanitizedIntegration,
      target_hint: sanitizedTargetHint,
      dr_clean_by: request.zeroDataRetention
        ? new Date(Date.now() + 24 * 60 * 60 * 1000)
        : null,
      api_key_id: request.api_key_id ?? null,
    },
    true,
    logger,
  );
}

export type LoggedScrape = {
  id: string;
  request_id: string;
  url: string;
  is_successful: boolean;
  error?: string;
  doc?: Document;
  time_taken: number;
  team_id: string;
  options: ScrapeOptions;
  cost_tracking?: ReturnType<typeof CostTracking.prototype.toJSON>;
  pdf_num_pages?: number;
  credits_cost: number;
  skipNuq: boolean;
  zeroDataRetention: boolean;
};

export async function logScrape(scrape: LoggedScrape, force: boolean = false) {
  const logger = _logger.child({
    module: "log_job",
    method: "logScrape",
    scrapeId: scrape.id,
    requestId: scrape.request_id,
    teamId: scrape.team_id,
    zeroDataRetention: scrape.zeroDataRetention,
  });

  await robustInsert(
    "scrapes",
    {
      id: scrape.id,
      request_id: scrape.request_id,
      url: scrape.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : scrape.url,
      is_successful: scrape.is_successful,
      error: scrape.error ?? null,
      time_taken: scrape.time_taken,
      team_id:
        scrape.team_id === "preview" || scrape.team_id?.startsWith("preview_")
          ? previewTeamId
          : scrape.team_id,
      options: scrape.zeroDataRetention ? null : scrape.options,
      cost_tracking: scrape.zeroDataRetention
        ? null
        : (scrape.cost_tracking ?? null),
      pdf_num_pages: scrape.zeroDataRetention
        ? null
        : (scrape.pdf_num_pages ?? null),
      credits_cost: scrape.credits_cost,
    },
    force,
    logger,
  );

  if (
    scrape.doc &&
    config.GCS_BUCKET_NAME &&
    !(scrape.skipNuq && scrape.zeroDataRetention)
  ) {
    await saveScrapeToGCS(scrape);
  }

  if (
    scrape.is_successful &&
    !scrape.zeroDataRetention &&
    config.USE_DB_AUTHENTICATION
  ) {
    const hasMarkdown = hasFormatOfType(scrape.options.formats, "markdown");
    const hasChangeTracking = hasFormatOfType(
      scrape.options.formats,
      "changeTracking",
    );

    if (hasMarkdown || hasChangeTracking) {
      const { error } = await supabase_service.rpc(
        "change_tracking_insert_scrape",
        {
          p_team_id: scrape.team_id,
          p_url: scrape.url,
          p_job_id: scrape.id,
          p_change_tracking_tag: hasChangeTracking
            ? hasChangeTracking.tag
            : null,
          p_date_added: new Date().toISOString(),
        },
      );

      if (error) {
        _logger.warn("Error inserting into change_tracking_scrapes", {
          error,
          scrapeId: scrape.id,
          teamId: scrape.team_id,
        });
      } else {
        _logger.debug("Change tracking record inserted successfully");
      }
    }
  }
}

type LoggedCrawl = {
  id: string;
  request_id: string;
  url: string;
  team_id: string;
  options: any;
  num_docs: number;
  credits_cost: number;
  zeroDataRetention: boolean;
  cancelled: boolean;
};

export async function logCrawl(crawl: LoggedCrawl, force: boolean = false) {
  const logger = _logger.child({
    module: "log_job",
    method: "logCrawl",
    crawlId: crawl.id,
    requestId: crawl.request_id,
    teamId: crawl.team_id,
    zeroDataRetention: crawl.zeroDataRetention,
  });

  await robustInsert(
    "crawls",
    {
      id: crawl.id,
      request_id: crawl.request_id,
      url: crawl.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : crawl.url,
      team_id:
        crawl.team_id === "preview" || crawl.team_id?.startsWith("preview_")
          ? previewTeamId
          : crawl.team_id,
      options: crawl.zeroDataRetention ? null : crawl.options,
      num_docs: crawl.num_docs,
      credits_cost: crawl.credits_cost,
      cancelled: crawl.cancelled,
    },
    force,
    logger,
  );
}

type LoggedBatchScrape = {
  id: string;
  request_id: string;
  team_id: string;
  num_docs: number;
  credits_cost: number;
  zeroDataRetention: boolean;
  cancelled: boolean;
};

export async function logBatchScrape(
  batchScrape: LoggedBatchScrape,
  force: boolean = false,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logBatchScrape",
    batchScrapeId: batchScrape.id,
    requestId: batchScrape.request_id,
    teamId: batchScrape.team_id,
    zeroDataRetention: batchScrape.zeroDataRetention,
  });

  await robustInsert(
    "batch_scrapes",
    {
      id: batchScrape.id,
      request_id: batchScrape.request_id,
      team_id:
        batchScrape.team_id === "preview" ||
        batchScrape.team_id?.startsWith("preview_")
          ? previewTeamId
          : batchScrape.team_id,
      num_docs: batchScrape.num_docs,
      credits_cost: batchScrape.credits_cost,
      cancelled: batchScrape.cancelled,
    },
    force,
    logger,
  );
}

export type LoggedSearch = {
  id: string;
  request_id: string;
  query: string;
  team_id: string;
  options: any;
  time_taken: number;
  credits_cost: number;
  is_successful: boolean;
  error?: string;
  num_results: number;
  results: any;
  zeroDataRetention: boolean;
};

export async function logSearch(search: LoggedSearch, force: boolean = false) {
  const logger = _logger.child({
    module: "log_job",
    method: "logSearch",
    searchId: search.id,
    requestId: search.request_id,
    teamId: search.team_id,
    zeroDataRetention: search.zeroDataRetention,
  });

  await robustInsert(
    "searches",
    {
      id: search.id,
      request_id: search.request_id,
      query: search.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : search.query,
      team_id:
        search.team_id === "preview" || search.team_id?.startsWith("preview_")
          ? previewTeamId
          : search.team_id,
      options: search.zeroDataRetention ? null : search.options,
      credits_cost: search.credits_cost,
      is_successful: search.is_successful,
      error: search.zeroDataRetention ? null : (search.error ?? null),
      num_results: search.num_results,
      time_taken: search.time_taken,
    },
    force,
    logger,
  );

  if (search.results && !search.zeroDataRetention) {
    await saveSearchToGCS(search);
  }
}

export type LoggedExtract = {
  id: string;
  request_id: string;
  urls: string[];
  team_id: string;
  options: any;
  model_kind: "fire-0" | "fire-1";
  credits_cost: number;
  is_successful: boolean;
  error?: string;
  result?: any;
  cost_tracking?: ReturnType<typeof CostTracking.prototype.toJSON>;
};

export async function logExtract(
  extract: LoggedExtract,
  force: boolean = false,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logExtract",
    extractId: extract.id,
    requestId: extract.request_id,
    teamId: extract.team_id,
  });

  await robustInsert(
    "extracts",
    {
      id: extract.id,
      request_id: extract.request_id,
      urls: extract.urls,
      team_id:
        extract.team_id === "preview" || extract.team_id?.startsWith("preview_")
          ? previewTeamId
          : extract.team_id,
      options: extract.options,
      model_kind: extract.model_kind,
      credits_cost: extract.credits_cost,
      is_successful: extract.is_successful,
      error: extract.error ?? null,
      cost_tracking: extract.cost_tracking ?? null,
    },
    force,
    logger,
  );

  if (extract.result) {
    await saveExtractToGCS(extract);
  }
}

export type LoggedMap = {
  id: string;
  request_id: string;
  url: string;
  team_id: string;
  options: any;
  results: any[];
  credits_cost: number;
  zeroDataRetention: boolean;
};

export async function logMap(map: LoggedMap, force: boolean = false) {
  const logger = _logger.child({
    module: "log_job",
    method: "logMap",
    mapId: map.id,
    requestId: map.request_id,
    teamId: map.team_id,
    zeroDataRetention: map.zeroDataRetention,
  });

  await robustInsert(
    "maps",
    {
      id: map.id,
      request_id: map.request_id,
      url: map.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : map.url,
      team_id:
        map.team_id === "preview" || map.team_id?.startsWith("preview_")
          ? previewTeamId
          : map.team_id,
      options: map.zeroDataRetention ? null : map.options,
      num_results: map.results.length,
      credits_cost: map.credits_cost,
    },
    force,
    logger,
  );

  if (map.results && !map.zeroDataRetention) {
    await saveMapToGCS(map);
  }
}

export type LoggedLlmsTxt = {
  id: string;
  request_id: string;
  url: string;
  team_id: string;
  options: any;
  num_urls: number;
  cost_tracking?: ReturnType<typeof CostTracking.prototype.toJSON>;
  credits_cost: number;
  result: { llmstxt: string; llmsfulltxt: string };
};

export async function logLlmsTxt(
  llmsTxt: LoggedLlmsTxt,
  force: boolean = false,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logLlmsTxt",
    llmsTxtId: llmsTxt.id,
    requestId: llmsTxt.request_id,
    teamId: llmsTxt.team_id,
  });

  await robustInsert(
    "llmstxts",
    {
      id: llmsTxt.id,
      request_id: llmsTxt.request_id,
      url: llmsTxt.url,
      team_id:
        llmsTxt.team_id === "preview" || llmsTxt.team_id?.startsWith("preview_")
          ? previewTeamId
          : llmsTxt.team_id,
      options: llmsTxt.options,
      num_urls: llmsTxt.num_urls,
      credits_cost: llmsTxt.credits_cost,
      cost_tracking: llmsTxt.cost_tracking ?? null,
    },
    force,
    logger,
  );

  if (llmsTxt.result) {
    await saveLlmsTxtToGCS(llmsTxt);
  }
}

export type LoggedDeepResearch = {
  id: string;
  request_id: string;
  query: string;
  team_id: string;
  options: any;
  time_taken: number;
  credits_cost: number;
  result: { finalAnalysis: string; sources: any; json: any };
  cost_tracking?: ReturnType<typeof CostTracking.prototype.toJSON>;
};

export async function logDeepResearch(
  deepResearch: LoggedDeepResearch,
  force: boolean = false,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logDeepResearch",
    deepResearchId: deepResearch.id,
    requestId: deepResearch.request_id,
    teamId: deepResearch.team_id,
  });

  await robustInsert(
    "deep_researches",
    {
      id: deepResearch.id,
      request_id: deepResearch.request_id,
      query: deepResearch.query,
      team_id:
        deepResearch.team_id === "preview" ||
        deepResearch.team_id?.startsWith("preview_")
          ? previewTeamId
          : deepResearch.team_id,
      options: deepResearch.options,
      time_taken: deepResearch.time_taken,
      credits_cost: deepResearch.credits_cost,
      cost_tracking: deepResearch.cost_tracking ?? null,
    },
    force,
    logger,
  );

  if (deepResearch.result) {
    await saveDeepResearchToGCS(deepResearch);
  }
}
