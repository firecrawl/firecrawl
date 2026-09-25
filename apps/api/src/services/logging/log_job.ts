import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { changeTrackingInsertScrape } from "../../lib/change-tracking-store";
import { config } from "../../config";
import { enqueueZdrCleanupJob } from "../../lib/zdr-queue";
import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { EXTERNAL_REQUEST_ID_MAX_BYTES } from "../../lib/external-request-id";
import { configDotenv } from "dotenv";
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
import {
  JOB_ACCESS_TTL_MS,
  isApiJobKind,
  normalizeJobAccessTeamId,
  writeApiJobAccess,
} from "../../lib/job-access-store";
import { writeFeedbackJob } from "../../lib/feedback-job-store";
import { setSpanAttributes, withSpan } from "../../lib/otel-tracer";
import {
  writeExtractJobState,
  writeScrapeJobState,
} from "../../lib/job-state-store";
import { buildReplayContextFromScrape } from "../../lib/scrape-interact/scrape-replay";
import {
  initializeRequestCredits,
  recordRequestCredits,
} from "../../lib/request-credits-store";
configDotenv();

const previewTeamId = "3adefd26-77ec-5968-8dcf-c94b5630d1de";
const DEFAULT_JOB_ACCESS_TTL_MS = JOB_ACCESS_TTL_MS;

async function withLogSpan<T>(
  params: {
    operation: string;
    table: string;
    id: string;
    requestId?: string;
    force?: boolean;
    zeroDataRetention?: boolean;
  },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `log_job.${params.operation}`,
    async span => {
      setSpanAttributes(span, {
        "log_job.table": params.table,
        "log_job.id": params.id,
        "log_job.request_id": params.requestId,
        "log_job.force": params.force,
      });
      return fn();
    },
    { zeroDataRetention: params.zeroDataRetention },
  );
}

async function writeFeedbackJobSafely(
  params: Parameters<typeof writeFeedbackJob>[0],
  logger: Logger,
): Promise<void> {
  try {
    await writeFeedbackJob(params);
  } catch (error) {
    logger.error("Failed to write feedback job to Bigtable", {
      error,
      jobId: params.jobId,
      endpoint: params.endpoint,
    });
  }
}

async function recordRequestCreditsSafely(
  params: Parameters<typeof recordRequestCredits>[0],
  logger: Logger,
): Promise<void> {
  try {
    await recordRequestCredits(params);
  } catch (error) {
    logger.error("Failed to record request credits in Bigtable", {
      error,
      requestId: params.requestId,
      jobId: params.jobId,
      credits: params.credits,
    });
  }
}

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
// Short attempts detect a stalled RPC quickly. The total budget allows
// retries across a longer connection disruption.
// Retry codes stay the client's defaults for Publish (DEADLINE_EXCEEDED,
// UNAVAILABLE, INTERNAL, UNKNOWN, ABORTED, CANCELLED, RESOURCE_EXHAUSTED).
// A retry can deliver a batch twice when the first attempt was persisted but
// its response was lost; the ClickHouse tables dedupe on row id, not message
// id, so those copies collapse.
//
// The log call waits for the publish, so the budget is what a caller can be
// held for while Pub/Sub is unreachable before the log call fails.
const PUBSUB_PUBLISH_OPTIONS: PublishOptions = {
  gaxOpts: {
    retry: {
      backoffSettings: {
        initialRetryDelayMillis: 250,
        retryDelayMultiplier: 2,
        maxRetryDelayMillis: 5_000,
        initialRpcTimeoutMillis: 10_000,
        rpcTimeoutMultiplier: 1,
        maxRpcTimeoutMillis: 10_000,
        totalTimeoutMillis: 30_000,
      },
    },
  },
};

// Shutdown waits this long for in-flight publishes before closing the client.
// The drain shares the existing pod grace period with active work and exit.
// Memory kills and work that exceeds the pod grace period can still lose logs.
const PUBSUB_SHUTDOWN_FLUSH_TIMEOUT_MS = 40_000;

// Track publication promises because topic.flush() can finish before an active RPC.
const pendingPublications = new Map<
  Promise<string>,
  { table: string; logId: string; startedAt: number }
>();
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
    return null;
  }
}

// One Topic per table so publishes share a batch. The topic is named after
// the table, behind the optional environment prefix (see PUBSUB_TOPIC_PREFIX).
function getTopic(client: PubSub, table: string): Topic {
  const name = `${config.PUBSUB_TOPIC_PREFIX}${table}`;
  let topic = pubSubTopics.get(name);
  if (!topic) {
    topic = client.topic(name, PUBSUB_PUBLISH_OPTIONS);
    pubSubTopics.set(name, topic);
  }
  return topic;
}

/** The publisher already holds as many unacknowledged rows as it may. */
class PubSubBacklogFullError extends Error {
  constructor() {
    super("Pub/Sub log publisher backlog is full");
    this.name = "PubSubBacklogFullError";
  }
}

/**
 * Publishes one job-log row to its Pub/Sub topic and waits for the
 * acknowledgement. Pub/Sub is the log's store of record, so a publish that
 * fails, is refused by a full backlog, or arrives during shutdown throws to
 * the caller; nothing else is written for that row.
 */
async function publishLog(table: string, data: any, logger: Logger) {
  const startedAt = Date.now();
  try {
    await withSpan("log_job.pubsub.publish", async span => {
      setSpanAttributes(span, {
        "log_job.table": table,
        "log_job.id": data.id,
        "messaging.system": "gcp_pubsub",
      });

      if (pubSubShutdown) {
        throw new Error("Pub/Sub log publisher is shutting down");
      }
      const client = getPubSubClient(logger);
      if (!client) {
        if (config.PUBSUB_CREDENTIALS) {
          throw new Error("Pub/Sub log publisher initialization failed");
        }
        setSpanAttributes(span, {
          "log_job.pubsub.enabled": false,
          "log_job.pubsub.outcome": "skipped",
        });
        return;
      }

      const payload = Buffer.from(JSON.stringify(data));
      setSpanAttributes(span, {
        "log_job.pubsub.enabled": true,
        "log_job.pubsub.payload_bytes": payload.length,
      });
      if (
        pendingPublications.size >= config.PUBSUB_MAX_OUTSTANDING_MESSAGES ||
        outstandingBytes + payload.length > config.PUBSUB_MAX_OUTSTANDING_BYTES
      ) {
        droppedTotal++;
        pubsubLogPublishTotal.inc({ table, outcome: "dropped" });
        setSpanAttributes(span, { "log_job.pubsub.outcome": "dropped" });
        const now = Date.now();
        if (now - lastDropWarningAt >= 60_000) {
          lastDropWarningAt = now;
          logger.warn("Refusing Pub/Sub log: publisher backlog is full", {
            table,
            logId: data.id,
            payloadBytes: payload.length,
            outstandingMessages: pendingPublications.size,
            outstandingBytes,
            droppedTotal,
          });
        }
        throw new PubSubBacklogFullError();
      }

      const publication = getTopic(client, table).publishMessage({
        data: payload,
      });
      pendingPublications.set(publication, {
        table,
        logId: data.id,
        startedAt,
      });
      outstandingBytes += payload.length;

      try {
        await publication;
        pubsubLogPublishTotal.inc({ table, outcome: "published" });
        setSpanAttributes(span, { "log_job.pubsub.outcome": "published" });
      } finally {
        pendingPublications.delete(publication);
        outstandingBytes -= payload.length;
      }
    });
  } catch (error) {
    // A backlog refusal counted itself as "dropped" and warned, rate-limited,
    // above; only a genuine publish failure is an error here.
    if (!(error instanceof PubSubBacklogFullError)) {
      pubsubLogPublishTotal.inc({ table, outcome: "failed" });
      logger.error("Failed to publish log to Pub/Sub", {
        error,
        table,
        logId: data.id,
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
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
  const startedAt = Date.now();
  logger.info("Draining Pub/Sub log publisher", {
    outstandingMessages: pendingPublications.size,
    outstandingBytes,
    timeoutMs: PUBSUB_SHUTDOWN_FLUSH_TIMEOUT_MS,
  });
  // Callers stop accepting work before shutdown. Reject new publications so
  // this snapshot includes every publication that can still use the client.
  const flushed = Promise.allSettled([
    ...[...pubSubTopics.values()].map(async topic => topic.flush()),
    ...pendingPublications.keys(),
  ]);
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
        outstandingMessages: pendingPublications.size,
        outstandingBytes,
        pendingLogSample: [...pendingPublications.values()].slice(0, 50),
        pendingLogSampleTruncated: pendingPublications.size > 50,
      },
    );
  } else {
    const errors = results.flatMap(result =>
      result.status === "rejected" ? [result.reason] : [],
    );

    if (errors.length > 0) {
      logger.error("Failed to drain Pub/Sub log publisher", { errors });
    } else {
      logger.info("Pub/Sub log publisher drained", {
        durationMs: Date.now() - startedAt,
      });
    }
  }

  let closeDeadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.close(),
      new Promise<never>((_, reject) => {
        closeDeadline = setTimeout(
          () => reject(new Error("Pub/Sub client close exceeded 5 seconds")),
          5_000,
        );
      }),
    ]);
  } catch (error) {
    logger.error("Failed to close Pub/Sub log publisher", { error });
  } finally {
    clearTimeout(closeDeadline);
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

  // The single point where a row leaves for both stores: clean it once so
  // PostgreSQL and ClickHouse receive identical, accepted values.
  data = sanitizeLogData({
    ...data,
    created_at: data.created_at ?? new Date(),
  });

  // Pub/Sub is the store of record: publish first and wait for it. A failed
  // publish fails the log call, and the PostgreSQL copy is not attempted.
  await publishLog(table, data, logger);

  // The PostgreSQL copy is on its way out; its failure is logged, not thrown.
  const attempts: { error: any; timeMs: number; backoffMs: number }[] = [];
  try {
    await withSpan("log_job.postgres.insert", async span => {
      setSpanAttributes(span, {
        "db.system": "postgresql",
        "log_job.table": table,
        "log_job.id": data.id,
        "log_job.force": force,
        "log_job.postgres.enabled": true,
      });
      const target = tableMap[table];

      const maxAttempts = force ? 10 : 1;
      for (let i = 0; i < maxAttempts; i++) {
        const backoffMs = i === 0 ? 0 : 75;
        const start = Date.now();
        try {
          await db.insert(target).values(data);
          attempts.push({
            error: null,
            timeMs: Date.now() - start,
            backoffMs,
          });
          break;
        } catch (error) {
          attempts.push({
            error,
            timeMs: Date.now() - start,
            backoffMs,
          });
          if (force) {
            await new Promise(resolve => setTimeout(resolve, 75));
          }
        }
      }

      const lastAttempt = attempts.at(-1);
      setSpanAttributes(span, {
        "log_job.postgres.attempts": attempts.length,
        "log_job.postgres.retries": Math.max(0, attempts.length - 1),
        "log_job.postgres.outcome":
          lastAttempt?.error === null ? "inserted" : "failed",
      });
      if (lastAttempt?.error !== null) {
        throw (
          lastAttempt?.error ?? new Error("Database insert was not attempted")
        );
      }
    });

    if (attempts.length === 1) {
      logger.debug("Inserted into database successfully", { attempts });
    } else {
      logger.warn("Inserted into database successfully with retries", {
        attempts,
      });
    }
  } catch {
    logger.error("Failed to insert into database", { attempts });
  }
}

type LoggedRequest = {
  id: string;
  kind:
    | "alexandria"
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
  jobAccess?: boolean;
  jobAccessExpiresAt?: Date;
  creditsShards?: number;
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
  return withLogSpan(
    {
      operation: "request",
      table: "requests",
      id: request.id,
      zeroDataRetention: request.zeroDataRetention,
    },
    () => logRequestInternal(request),
  );
}

async function logRequestInternal(request: LoggedRequest) {
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
  const storedTeamId =
    request.team_id === "preview" || request.team_id?.startsWith("preview_")
      ? previewTeamId
      : request.team_id;
  const jobAccessTeamId = normalizeJobAccessTeamId(request.team_id);

  if (request.jobAccess !== false && isApiJobKind(request.kind)) {
    try {
      await writeApiJobAccess({
        id: request.id,
        teamId: jobAccessTeamId,
        kind: request.kind,
        expiresAt:
          request.jobAccessExpiresAt ??
          new Date(Date.now() + DEFAULT_JOB_ACCESS_TTL_MS),
        clientOrigin: sanitizedOrigin,
        zeroDataRetention: request.zeroDataRetention,
      });
    } catch (error) {
      logger.error("Failed to write API job access to Bigtable", {
        error,
        kind: request.kind,
      });
    }
  }

  if (request.creditsShards !== undefined) {
    try {
      await initializeRequestCredits(request.id, request.creditsShards);
    } catch (error) {
      logger.error("Failed to initialize request credits in Bigtable", {
        error,
        shards: request.creditsShards,
      });
    }
  }

  if (request.zeroDataRetention && config.USE_DB_AUTHENTICATION === true) {
    await enqueueZdrCleanupJob(request.id);
  }

  await robustInsert(
    "requests",
    {
      id: request.id,
      kind: request.kind,
      api_version: request.api_version,
      team_id: storedTeamId,
      origin: sanitizedOrigin,
      integration: sanitizedIntegration,
      target_hint: sanitizedTargetHint,
      api_key_id: request.api_key_id ?? null,
      // Not redacted under zero data retention: it is the caller's own
      // operation id (attribution it asked for), not customer content — and
      // the row's blobs are cleaned by the ZDR queue regardless.
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
  /** False for jobs that must not be fetchable by id (defaults to true). */
  jobAccess?: boolean;
};

export type ScrapeStateOutcome =
  /** The terminal state is readable from Bigtable. */
  | "written"
  /** Nothing to write: a parse job, or no state table configured. */
  | "skipped"
  /** The Bigtable write threw; the error is logged here. */
  | "failed";

type LogScrapeHooks = {
  /**
   * Called once the terminal state write has settled, before anything else
   * is logged. The sync scrape path waits on this before answering, so an
   * interact call that follows the response finds its replay context.
   */
  onStateWritten?: (outcome: ScrapeStateOutcome) => void;
};

export async function logScrape(
  scrape: LoggedScrape,
  force: boolean = false,
  hooks?: LogScrapeHooks,
) {
  return withLogSpan(
    {
      operation: scrape.is_parse ? "parse" : "scrape",
      table: scrape.is_parse ? "parses" : "scrapes",
      id: scrape.id,
      requestId: scrape.request_id,
      force,
      zeroDataRetention: scrape.zeroDataRetention,
    },
    () => logScrapeInternal(scrape, force, hooks),
  );
}

async function logScrapeInternal(
  scrape: LoggedScrape,
  force: boolean = false,
  hooks?: LogScrapeHooks,
) {
  const logger = _logger.child({
    module: "log_job",
    method: "logScrape",
    scrapeId: scrape.id,
    requestId: scrape.request_id,
    teamId: scrape.team_id,
    zeroDataRetention: scrape.zeroDataRetention,
  });

  const tableName = scrape.is_parse ? "parses" : "scrapes";
  const storedTeamId =
    keylessTeamUuid(scrape.team_id) ??
    (scrape.team_id === "preview" || scrape.team_id?.startsWith("preview_")
      ? previewTeamId
      : scrape.team_id);

  // Terminal state for every scrape job, standalone or child, so status reads
  // never need the PostgreSQL row. It goes first: the sync scrape response
  // waits for it, and nothing else here has to be readable that early.
  let stateOutcome: ScrapeStateOutcome = "skipped";
  try {
    if (!scrape.is_parse) {
      const replay = scrape.zeroDataRetention
        ? undefined
        : buildReplayContextFromScrape({
            id: scrape.id,
            team_id: storedTeamId,
            url: scrape.url,
            options: scrape.options,
          }).context;
      const written = await writeScrapeJobState(scrape.id, {
        status: scrape.is_successful ? "completed" : "failed",
        requestId: scrape.request_id,
        completedAtMs: Date.now(),
        creditsBilled: scrape.credits_cost,
        ...(scrape.zeroDataRetention
          ? {}
          : {
              ...(scrape.error ? { error: scrape.error } : {}),
              ...(replay ? { replay } : {}),
              ...(scrape.options.profile
                ? { profile: scrape.options.profile }
                : {}),
              ...(typeof (scrape.options as any).origin === "string"
                ? { origin: (scrape.options as any).origin }
                : {}),
            }),
      });
      stateOutcome = written ? "written" : "skipped";
    }
  } catch (error) {
    stateOutcome = "failed";
    logger.error("Failed to write scrape state to Bigtable", { error });
  } finally {
    hooks?.onStateWritten?.(stateOutcome);
  }

  const feedbackJob = {
    jobId: scrape.id,
    requestId: scrape.request_id,
    teamId: storedTeamId,
    succeeded: scrape.is_successful,
    creditsBilled: scrape.credits_cost,
    zeroDataRetention: scrape.zeroDataRetention,
  };
  await writeFeedbackJobSafely(
    scrape.is_parse
      ? { ...feedbackJob, endpoint: "parse" }
      : { ...feedbackJob, endpoint: "scrape", scrapeOptions: scrape.options },
    logger,
  );

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
      team_id: storedTeamId,
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

  if (scrape.id !== scrape.request_id) {
    await recordRequestCreditsSafely(
      {
        requestId: scrape.request_id,
        jobId: scrape.id,
        credits: scrape.credits_cost,
      },
      logger,
    );

    // A crawl or batch child is fetched by its own id (`GET /scrape/{id}`,
    // typically off the crawl `page` webhook), so it needs its own access row.
    // Standalone scrapes get theirs from logRequest.
    if (!scrape.is_parse && scrape.jobAccess !== false) {
      try {
        await writeApiJobAccess({
          id: scrape.id,
          teamId: normalizeJobAccessTeamId(scrape.team_id),
          kind: "scrape",
          expiresAt: new Date(Date.now() + DEFAULT_JOB_ACCESS_TTL_MS),
          zeroDataRetention: scrape.zeroDataRetention,
        });
      } catch (error) {
        logger.error("Failed to write child scrape job access to Bigtable", {
          error,
        });
      }
    }
  }

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

type LoggedProviderScrape = {
  id: string;
  request_id: string;
  target: string;
  team_id: string;
  options: unknown;
  time_taken: number;
  credits_cost: number;
  is_successful: boolean;
  error?: string;
};

export async function logProviderScrape(scrape: LoggedProviderScrape) {
  return withLogSpan(
    {
      operation: "provider_scrape",
      table: "scrapes",
      id: scrape.id,
      requestId: scrape.request_id,
      zeroDataRetention: false,
    },
    () => logProviderScrapeInternal(scrape),
  );
}

async function logProviderScrapeInternal(scrape: LoggedProviderScrape) {
  const logger = _logger.child({
    module: "log_job",
    method: "logProviderScrape",
    scrapeId: scrape.id,
    requestId: scrape.request_id,
    teamId: scrape.team_id,
  });
  const storedTeamId =
    keylessTeamUuid(scrape.team_id) ??
    (scrape.team_id === "preview" || scrape.team_id?.startsWith("preview_")
      ? previewTeamId
      : scrape.team_id);

  await robustInsert(
    "scrapes",
    {
      id: scrape.id,
      request_id: scrape.request_id,
      url: scrape.target,
      is_successful: scrape.is_successful,
      error: scrape.error ?? null,
      time_taken: scrape.time_taken,
      team_id: storedTeamId,
      options: scrape.options,
      cost_tracking: null,
      pdf_num_pages: null,
      credits_cost: scrape.credits_cost,
      monitor_id: null,
      monitor_check_id: null,
      content_type: null,
    },
    false,
    logger,
  );
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
  return withLogSpan(
    {
      operation: "crawl",
      table: "crawls",
      id: crawl.id,
      requestId: crawl.request_id,
      force,
      zeroDataRetention: crawl.zeroDataRetention,
    },
    () => logCrawlInternal(crawl, force),
  );
}

async function logCrawlInternal(crawl: LoggedCrawl, force: boolean = false) {
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
  return withLogSpan(
    {
      operation: "batch_scrape",
      table: "batch_scrapes",
      id: batchScrape.id,
      requestId: batchScrape.request_id,
      force,
      zeroDataRetention: batchScrape.zeroDataRetention,
    },
    () => logBatchScrapeInternal(batchScrape, force),
  );
}

async function logBatchScrapeInternal(
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
  return withLogSpan(
    {
      operation: "search",
      table: "searches",
      id: search.id,
      requestId: search.request_id,
      force,
      zeroDataRetention: search.zeroDataRetention,
    },
    () => logSearchInternal(search, force),
  );
}

async function logSearchInternal(search: LoggedSearch, force: boolean = false) {
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
  const storedTeamId =
    search.team_id === "preview" || search.team_id?.startsWith("preview_")
      ? previewTeamId
      : search.team_id;

  await writeFeedbackJobSafely(
    {
      jobId: search.id,
      requestId: search.request_id,
      teamId: storedTeamId,
      endpoint: "search",
      succeeded: search.is_successful,
      creditsBilled: search.credits_cost,
      zeroDataRetention: search.zeroDataRetention,
    },
    logger,
  );

  await robustInsert(
    "searches",
    {
      id: search.id,
      request_id: search.request_id,
      query: search.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : sanitizeString(search.query),
      team_id: storedTeamId,
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

  if (search.id !== search.request_id) {
    await recordRequestCreditsSafely(
      {
        requestId: search.request_id,
        jobId: search.id,
        credits: search.credits_cost,
      },
      logger,
    );
  }

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
  return withLogSpan(
    {
      operation: "research",
      table: research.table,
      id: research.id,
      requestId: research.request_id,
      force,
      zeroDataRetention: research.zeroDataRetention,
    },
    () => logResearchEndpointInternal(research, force),
  );
}

async function logResearchEndpointInternal(
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
  return withLogSpan(
    {
      operation: "extract",
      table: "extracts",
      id: extract.id,
      requestId: extract.request_id,
      force,
    },
    () => logExtractInternal(extract, force),
  );
}

async function logExtractInternal(
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

  try {
    await writeExtractJobState(extract.id, {
      status: extract.is_successful ? "completed" : "failed",
      completedAtMs: Date.now(),
      creditsBilled: extract.credits_cost,
      ...(extract.error ? { error: extract.error } : {}),
    });
  } catch (error) {
    logger.error("Failed to write extract state to Bigtable", { error });
  }

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
  return withLogSpan(
    {
      operation: "map",
      table: "maps",
      id: map.id,
      requestId: map.request_id,
      force,
      zeroDataRetention: map.zeroDataRetention,
    },
    () => logMapInternal(map, force),
  );
}

async function logMapInternal(map: LoggedMap, force: boolean = false) {
  const logger = _logger.child({
    module: "log_job",
    method: "logMap",
    mapId: map.id,
    requestId: map.request_id,
    teamId: map.team_id,
    zeroDataRetention: map.zeroDataRetention,
  });
  const storedTeamId =
    map.team_id === "preview" || map.team_id?.startsWith("preview_")
      ? previewTeamId
      : map.team_id;

  await writeFeedbackJobSafely(
    {
      jobId: map.id,
      requestId: map.request_id,
      teamId: storedTeamId,
      endpoint: "map",
      succeeded: true,
      creditsBilled: map.credits_cost,
      zeroDataRetention: map.zeroDataRetention,
    },
    logger,
  );

  await robustInsert(
    "maps",
    {
      id: map.id,
      request_id: map.request_id,
      url: map.zeroDataRetention
        ? "<redacted due to zero data retention>"
        : map.url,
      team_id: storedTeamId,
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
  return withLogSpan(
    {
      operation: "llmstxt",
      table: "llmstxts",
      id: llmsTxt.id,
      requestId: llmsTxt.request_id,
      force,
    },
    () => logLlmsTxtInternal(llmsTxt, force),
  );
}

async function logLlmsTxtInternal(
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
  return withLogSpan(
    {
      operation: "deep_research",
      table: "deep_researches",
      id: deepResearch.id,
      requestId: deepResearch.request_id,
      force,
    },
    () => logDeepResearchInternal(deepResearch, force),
  );
}

async function logDeepResearchInternal(
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
