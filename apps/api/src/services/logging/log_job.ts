import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { changeTrackingInsertScrape } from "../../lib/change-tracking-store";
import { config } from "../../config";
import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { EXTERNAL_REQUEST_ID_MAX_BYTES } from "../../lib/external-request-id";
import { configDotenv } from "dotenv";
import * as Sentry from "@sentry/node";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  saveDeepResearchToGCS,
  saveExtractToGCS,
  saveLlmsTxtToGCS,
  saveMapToGCS,
  saveScrapeToGCS,
  saveSearchToGCS,
} from "../../lib/gcs-jobs";
import { hasFormatOfType } from "../../lib/format-utils";
import { keylessTeamUuid } from "../../lib/keyless";
import type { Document, ScrapeOptions } from "../../controllers/v2/types";
import type { CostTracking } from "../../lib/cost-tracking";
import type { Logger } from "winston";
import { saveExtractResult } from "../../lib/extract/extract-redis";
import { trackFirstSurfaceUse } from "../posthog";
import { PubSub, type PublishOptions, type Topic } from "@google-cloud/pubsub";
import { pubsubLogPublishTotal } from "../../lib/pubsub-log-metrics";
import { sanitizeLogData, sanitizeText } from "./sanitize";
configDotenv();

const previewTeamId = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

/**
 * Null-aware wrapper around the shared text sanitizer, kept where a cleaned
 * value feeds a later decision (the external_request_id byte cap). Every row
 * is deep-sanitized again in robustInsert before it reaches either store, so
 * nothing else depends on this being called; see ./sanitize.ts for what gets
 * cleaned and why.
 */
function sanitizeString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  return sanitizeText(value);
}

const tableMap: Record<string, PgTable> = {
  requests: schema.requests,
  scrapes: schema.scrapes,
  parses: schema.parses,
  crawls: schema.crawls,
  batch_scrapes: schema.batch_scrapes,
  searches: schema.searches,
  research_paper_searches: schema.research_paper_searches,
  research_paper_inspects: schema.research_paper_inspects,
  research_paper_reads: schema.research_paper_reads,
  research_related_papers: schema.research_related_papers,
  research_github_searches: schema.research_github_searches,
  code_searches: schema.code_searches,
  extracts: schema.extracts,
  maps: schema.maps,
  llmstxts: schema.llmstxts,
  deep_researches: schema.deep_researches,
};

let pubSubClient: PubSub | null | undefined;
const pubSubTopics = new Map<string, Topic>();
let pubSubShutdown: Promise<void> | undefined;

// Publish retry policy. Passing only `timeout` makes google-gax collapse the
// whole retry budget to that one value (CallSettings.merge), so a stalled RPC
// used to be a single 60 s attempt and then a lost row. An explicit `retry`
// is applied after that override and replaces the backoff settings wholesale.
// Short attempts detect a hung channel quickly; the total budget covers every
// stall measured in production so far, all of which cleared within 140 s.
// Retry codes stay the client's defaults for Publish (DEADLINE_EXCEEDED,
// UNAVAILABLE, INTERNAL, UNKNOWN, ABORTED, CANCELLED, RESOURCE_EXHAUSTED).
// A retry can deliver a batch twice when the first attempt was persisted but
// its response was lost; the ClickHouse tables dedupe on row id, not message
// id, so those copies collapse.
const PUBSUB_PUBLISH_OPTIONS: PublishOptions = {
  gaxOpts: {
    retry: {
      backoffSettings: {
        initialRetryDelayMillis: 250,
        retryDelayMultiplier: 2,
        maxRetryDelayMillis: 15_000,
        initialRpcTimeoutMillis: 15_000,
        rpcTimeoutMultiplier: 1,
        maxRpcTimeoutMillis: 15_000,
        totalTimeoutMillis: 300_000,
      },
    },
  },
};

// Shutdown waits this long for in-flight publishes before closing the client.
// It must fit inside the pods' termination grace period (60 s for nuq
// workers); a stall that outlives it loses what is still in flight, which is
// the same outcome as today and what a durable relay is for.
const PUBSUB_SHUTDOWN_FLUSH_TIMEOUT_MS = 40_000;

// Rows waiting on Pub/Sub across all topics. Publishing is fire-and-forget,
// so during a stall this is what grows; see PUBSUB_MAX_OUTSTANDING_* in config.
let outstandingMessages = 0;
let outstandingBytes = 0;
let droppedTotal = 0;
let lastDropWarningAt = 0;

function getPubSubClient(logger: Logger): PubSub | null {
  if (pubSubClient !== undefined) return pubSubClient;
  if (!config.PUBSUB_CREDENTIALS) return (pubSubClient = null);

  try {
    const credentials = JSON.parse(
      Buffer.from(config.PUBSUB_CREDENTIALS, "base64").toString("utf8"),
    );
    return (pubSubClient = new PubSub({
      projectId: credentials.project_id,
      credentials,
    }));
  } catch (error) {
    pubSubClient = null;
    logger.error("Failed to initialize Pub/Sub log publisher", { error });
    Sentry.captureException(error, {
      tags: { operation: "initializePubSubLogPublisher" },
    });
    return null;
  }
}

// One Topic per table so publishes share a batch.
function getTopic(client: PubSub, table: string): Topic {
  let topic = pubSubTopics.get(table);
  if (!topic) {
    topic = client.topic(table, PUBSUB_PUBLISH_OPTIONS);
    pubSubTopics.set(table, topic);
  }
  return topic;
}

async function publishLog(table: string, data: any, logger: Logger) {
  const client = getPubSubClient(logger);
  if (!client) return;

  const payload = Buffer.from(JSON.stringify(data));
  if (
    outstandingMessages >= config.PUBSUB_MAX_OUTSTANDING_MESSAGES ||
    outstandingBytes + payload.length > config.PUBSUB_MAX_OUTSTANDING_BYTES
  ) {
    droppedTotal++;
    pubsubLogPublishTotal.inc({ table, outcome: "dropped" });
    const now = Date.now();
    if (now - lastDropWarningAt >= 60_000) {
      lastDropWarningAt = now;
      logger.warn("Dropping Pub/Sub log: publisher backlog is full", {
        outstandingMessages,
        outstandingBytes,
        droppedTotal,
      });
    }
    return;
  }

  outstandingMessages++;
  outstandingBytes += payload.length;
  try {
    await getTopic(client, table).publishMessage({ data: payload });
    pubsubLogPublishTotal.inc({ table, outcome: "published" });
  } catch (error) {
    pubsubLogPublishTotal.inc({ table, outcome: "failed" });
    logger.error("Failed to publish log to Pub/Sub", { error });
    Sentry.captureException(error, {
      tags: { table, operation: "publishPubSubLog" },
    });
  } finally {
    outstandingMessages--;
    outstandingBytes -= payload.length;
  }
}

export function shutdownPubSubLogging(): Promise<void> {
  if (pubSubShutdown) return pubSubShutdown;

  pubSubShutdown = shutdownPubSubLoggingOnce();
  return pubSubShutdown;
}

async function shutdownPubSubLoggingOnce(): Promise<void> {
  const client = pubSubClient;
  if (!client) return;

  const logger = _logger.child({
    module: "log_job",
    method: "shutdownPubSubLogging",
  });
  const flushed = Promise.allSettled(
    [...pubSubTopics.values()].map(topic => topic.flush()),
  );
  let deadline: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">(resolve => {
    deadline = setTimeout(
      () => resolve("timeout"),
      PUBSUB_SHUTDOWN_FLUSH_TIMEOUT_MS,
    );
  });
  const results = await Promise.race([flushed, timedOut]);
  clearTimeout(deadline);

  if (results === "timeout") {
    logger.warn(
      "Pub/Sub log flush did not finish before the shutdown deadline; closing anyway",
      {
        timeoutMs: PUBSUB_SHUTDOWN_FLUSH_TIMEOUT_MS,
        outstandingMessages,
        outstandingBytes,
      },
    );
  } else {
    const errors = results.flatMap(result =>
      result.status === "rejected" ? [result.reason] : [],
    );

    if (errors.length > 0) {
      logger.error("Failed to flush Pub/Sub log publisher", { errors });
      Sentry.captureException(errors[0], {
        tags: { operation: "flushPubSubLogPublisher" },
        extra: { failures: errors.length },
      });
    }
  }

  try {
    await client.close();
  } catch (error) {
    logger.error("Failed to close Pub/Sub log publisher", { error });
    Sentry.captureException(error, {
      tags: { operation: "closePubSubLogPublisher" },
    });
  }
}

async function robustInsert(
  table: string,
  data: any,
  force: boolean,
  _logger: Logger,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "robustInsert",
    table,
    canonicalLog: "log_job/robustInsert",
  });

  if (config.USE_DB_AUTHENTICATION !== true) {
    logger.info(
      "Skipping database insertion due to USE_DB_AUTHENTICATION being off",
    );
    return;
  }

  const target = tableMap[table];
  // The single point where a row leaves for both stores: clean it once so
  // PostgreSQL and ClickHouse receive identical, accepted values.
  data = sanitizeLogData({
    ...data,
    created_at: data.created_at ?? new Date(),
  });
  void publishLog(table, data, logger);

  const attempts: { error: any; timeMs: number; backoffMs: number }[] = [];

  if (force) {
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      try {
        await db.insert(target).values(data);
        attempts.push({
          error: null,
          timeMs: Date.now() - start,
          backoffMs: i === 0 ? 0 : 75,
        });
        break;
      } catch (error) {
        attempts.push({
          error,
          timeMs: Date.now() - start,
          backoffMs: i === 0 ? 0 : 75,
        });
        await new Promise(resolve => setTimeout(resolve, 75));
      }
    }

    if (attempts.length === 1 && attempts[0].error === null) {
      logger.debug("Inserted into database successfully", { attempts });
    } else if (
      attempts.length > 1 &&
      attempts[attempts.length - 1].error === null
    ) {
      logger.warn("Inserted into database successfully with retries", {
        attempts,
      });
    } else {
      logger.error("Failed to insert into database", { attempts });
      // Report to Sentry with context
      Sentry.captureException(
        attempts[attempts.length - 1]?.error ||
          new Error("Database insert failed after 10 attempts"),
        {
          tags: {
            table,
            operation: "robustInsert",
          },
          extra: {
            table,
            data: JSON.stringify(data).substring(0, 500), // Limit size
            attempts: 10,
            lastError: attempts[attempts.length - 1]?.error
              ? JSON.stringify(attempts[attempts.length - 1].error)
              : null,
          },
        },
      );
    }
  } else {
    const start = Date.now();
    try {
      await db.insert(target).values(data);
      attempts.push({ error: null, timeMs: Date.now() - start, backoffMs: 0 });
      logger.debug("Inserted into database successfully", { attempts });
    } catch (error) {
      attempts.push({ error, timeMs: Date.now() - start, backoffMs: 0 });
      logger.error("Failed to insert into database", { attempts });
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
    | "map"
    | "parse"
    | "agent"
    | "browser"
    | "interact"
    | "research_paper_search"
    | "research_paper_inspect"
    | "research_paper_read"
    | "research_related_papers"
    | "research_github_search"
    | "code_search";
  api_version: string;
  team_id: string;
  origin?: string;
  integration?: string | null;
  target_hint: string;
  zeroDataRetention: boolean;
  api_key_id?: number | null;
  /**
   * Opaque per-operation id a caller sent as `External-Request-Id` (see
   * `lib/external-request-id.ts`), stored for internal billing attribution
   * and read back off this row by the request id.
   */
  external_request_id?: string | null;
};

/**
 * The 2048-byte cap, re-checked at the one place the column is written.
 *
 * Belt and braces: the header helper (`lib/external-request-id.ts`) already
 * drops oversized ids, but the bound must hold even for a future writer that
 * bypasses it — and it cannot live in the database, where a length constraint
 * would fail the whole `requests` insert (and the `scrapes`/`crawls` rows that
 * FK into it) over a telemetry field. Oversized means null, never truncation:
 * a truncated opaque id handed back downstream would be actively wrong, where
 * an absent one is an honest reporting gap.
 */
function boundedExternalRequestId(
  value: string | null,
  logger: Logger,
): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value) <= EXTERNAL_REQUEST_ID_MAX_BYTES) return value;
  logger.warn(
    "external_request_id exceeds the cap at the insert boundary; storing null",
    {
      bytes: Buffer.byteLength(value),
      max: EXTERNAL_REQUEST_ID_MAX_BYTES,
    },
  );
  return null;
}

export async function logRequest(request: LoggedRequest) {
  const logger = _logger.child({
    module: "log_job",
    method: "logRequest",
    requestId: request.id,
    teamId: request.team_id,
    zeroDataRetention: request.zeroDataRetention,
  });

  // Emit a one-time PostHog milestone the first time this team uses each
  // surface (playground / sdk / mcp / cli / api / ...). Fire-and-forget.
  // Skip zero-data-retention requests — don't send their metadata to PostHog.
  if (!request.zeroDataRetention) {
    trackFirstSurfaceUse({
      teamId: request.team_id,
      origin: request.origin,
      integration: request.integration,
      kind: request.kind,
      apiVersion: request.api_version,
      apiKeyId: request.api_key_id,
    });
  }

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
      // Not redacted under zero data retention: it is the caller's own
      // operation id (attribution it asked for), not customer content — and
      // the row is cleaned at dr_clean_by regardless.
      external_request_id: boundedExternalRequestId(
        sanitizeString(request.external_request_id ?? null),
        logger,
      ),
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
  content_type?: string | null;
  credits_cost: number;
  skipNuq: boolean;
  zeroDataRetention: boolean;
  is_parse?: boolean;
  monitor_id?: string | null;
  monitor_check_id?: string | null;
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

  const tableName = scrape.is_parse ? "parses" : "scrapes";

  await robustInsert(
    tableName,
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
        keylessTeamUuid(scrape.team_id) ??
        (scrape.team_id === "preview" || scrape.team_id?.startsWith("preview_")
          ? previewTeamId
          : scrape.team_id),
      options: scrape.zeroDataRetention ? null : scrape.options,
      cost_tracking: scrape.zeroDataRetention
        ? null
        : (scrape.cost_tracking ?? null),
      pdf_num_pages: scrape.zeroDataRetention
        ? null
        : (scrape.pdf_num_pages ?? null),
      credits_cost: scrape.credits_cost,
      ...(scrape.is_parse
        ? {}
        : {
            monitor_id: scrape.monitor_id ?? null,
            monitor_check_id: scrape.monitor_check_id ?? null,
            content_type: scrape.content_type ?? null,
          }),
    },
    force,
    logger,
  );

  if (
    !scrape.is_parse &&
    scrape.doc &&
    config.GCS_BUCKET_NAME &&
    !(scrape.skipNuq && scrape.zeroDataRetention)
  ) {
    await saveScrapeToGCS(scrape, logger);
  }

  if (
    !scrape.is_parse &&
    scrape.is_successful &&
    !scrape.zeroDataRetention &&
    config.USE_DB_AUTHENTICATION &&
    !scrape.team_id.startsWith("preview_")
  ) {
    const hasMarkdown = hasFormatOfType(scrape.options.formats, "markdown");
    const hasChangeTracking = hasFormatOfType(
      scrape.options.formats,
      "changeTracking",
    );

    if (hasMarkdown || hasChangeTracking) {
      try {
        await changeTrackingInsertScrape({
          team_id: scrape.team_id,
          url: scrape.url,
          job_id: scrape.id,
          tag: hasChangeTracking ? hasChangeTracking.tag : null,
          date_added: new Date(),
        });
        _logger.debug("Change tracking record inserted successfully");
      } catch (error) {
        _logger.warn("Error inserting into change_tracking_scrapes", {
          error,
          scrapeId: scrape.id,
          teamId: scrape.team_id,
        });
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
  monitor_id?: string | null;
  monitor_check_id?: string | null;
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
      monitor_id: crawl.monitor_id ?? null,
      monitor_check_id: crawl.monitor_check_id ?? null,
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

  const options =
    search.zeroDataRetention || typeof search.options?.query !== "string"
      ? search.options
      : { ...search.options, query: sanitizeString(search.options.query) };

  await robustInsert(
    "searches",
    {
      id: search.id,
      request_id: search.request_id,
      query: search.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : sanitizeString(search.query),
      team_id:
        search.team_id === "preview" || search.team_id?.startsWith("preview_")
          ? previewTeamId
          : search.team_id,
      options: search.zeroDataRetention
        ? { enterprise: search.options?.enterprise }
        : options,
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
    await saveSearchToGCS(search, logger);
  }
}

export type ResearchRequestKind =
  | "research_paper_search"
  | "research_paper_inspect"
  | "research_paper_read"
  | "research_related_papers"
  | "research_github_search"
  | "code_search";

export type ResearchTableName =
  | "research_paper_searches"
  | "research_paper_inspects"
  | "research_paper_reads"
  | "research_related_papers"
  | "research_github_searches"
  | "code_searches";

type LoggedResearchEndpoint = {
  table: ResearchTableName;
  id: string;
  request_id: string;
  target: string;
  team_id: string;
  options: any;
  response: any;
  num_results: number;
  time_taken: number;
  credits_cost: number;
  is_successful: boolean;
  error?: string;
  zeroDataRetention: boolean;
};

export async function logResearchEndpoint(
  research: LoggedResearchEndpoint,
  force: boolean = false,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logResearchEndpoint",
    researchId: research.id,
    requestId: research.request_id,
    teamId: research.team_id,
    zeroDataRetention: research.zeroDataRetention,
  });

  await robustInsert(
    research.table,
    {
      id: research.id,
      request_id: research.request_id,
      target: research.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : (sanitizeString(research.target) ?? ""),
      team_id:
        keylessTeamUuid(research.team_id) ??
        (research.team_id === "preview" ||
        research.team_id?.startsWith("preview_")
          ? previewTeamId
          : research.team_id),
      options: research.zeroDataRetention ? null : research.options,
      response: research.zeroDataRetention ? null : research.response,
      num_results: research.num_results,
      time_taken: research.time_taken,
      credits_cost: research.credits_cost,
      is_successful: research.is_successful,
      error: research.zeroDataRetention ? null : (research.error ?? null),
    },
    force,
    logger,
  );
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
    if (config.GCS_BUCKET_NAME) {
      await saveExtractToGCS(extract, logger);
    } else {
      // Fallback: save result to Redis with 24h TTL when GCS is not configured
      await saveExtractResult(extract.id, extract.result);
    }
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
    await saveMapToGCS(map, logger);
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
    await saveLlmsTxtToGCS(llmsTxt, logger);
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
    await saveDeepResearchToGCS(deepResearch, logger);
  }
}
