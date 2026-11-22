import undici from "undici";
import { config } from "../../config";
import { createHmac } from "crypto";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getSecureDispatcherNoCookies,
  isIPPrivate,
} from "../../scraper/scrapeURL/engines/utils/safeFetch";
import type {
  WebhookConfig,
  WebhookEvent,
  WebhookEventDataMap,
  WebhookQueueMessage,
} from "./types";
import { redisEvictConnection } from "../redis";
import { db } from "../../db/connection";
import * as schema from "../../db/schema";
import { webhookQueue } from "./queue";
import { randomUUID } from "crypto";

const WEBHOOK_INSERT_QUEUE_KEY = "webhook-insert-queue";
const WEBHOOK_INSERT_BATCH_SIZE = 1000;
const WEBHOOK_INSERT_MAX_QUEUE_LENGTH = 100_000;

type WebhookSendResult = {
  attempted: boolean;
  delivered?: boolean;
  queued?: boolean;
  skipped?: boolean;
  statusCode?: number;
};

export function webhookEventMatchesFilter(
  configuredEvents: string[] | undefined,
  event: WebhookEvent,
): boolean {
  if (!configuredEvents?.length) {
    return true;
  }

  const legacySubType = event.split(".")[1];
  const namespaceSuffix = event.split(".").slice(1).join(".");
  return (
    configuredEvents.includes(event) ||
    configuredEvents.includes(legacySubType) ||
    configuredEvents.includes(namespaceSuffix)
  );
}

type WebhookSenderContext = {
  teamId: string;
  jobId: string;
  v0: boolean;
  zeroDataRetention?: boolean;
};

export class WebhookSender {
  private config: WebhookConfig;
  private secret?: string;
  private context: WebhookSenderContext;
  private logger: any;

  constructor(
    config: WebhookConfig,
    secret: string | undefined,
    context: WebhookSenderContext,
  ) {
    this.config = config;
    this.secret = secret;
    this.context = context;
    this.logger = _logger.child({
      module: "webhook-sender",
      teamId: context.teamId,
      jobId: context.jobId,
      isV0: context.v0,
    });
  }

  async send<T extends WebhookEvent>(
    event: T,
    data: WebhookEventDataMap[T],
  ): Promise<WebhookSendResult> {
    if (!this.shouldSendEvent(event)) {
      return { attempted: false, skipped: true };
    }

    const payload = {
      success: data.success,
      type: event,
      [this.context.v0 ? "jobId" : "id"]: this.context.jobId,
      webhookId: randomUUID(), // Unique ID for this webhook delivery (used for e.g. retries)
      data: "data" in data ? data.data : [],
      error: "error" in data ? data.error : undefined,
      metadata: this.config.metadata || undefined,
    };

    const delivery = this.deliver(
      payload,
      (data as any)?.scrapeId ?? undefined,
    );

    if (data.awaitWebhook) {
      return { attempted: true, ...(await delivery) };
    }

    delivery.catch(() => {});
    return {
      attempted: true,
      delivered: false,
      queued: this.usesWebhookQueue(),
    };
  }

  private shouldSendEvent(event: WebhookEvent): boolean {
    if (config.DISABLE_WEBHOOK_DELIVERY) {
      return false;
    }

    return webhookEventMatchesFilter(this.config.events, event);
  }

  private usesWebhookQueue(): boolean {
    return Boolean(config.WEBHOOK_USE_RABBITMQ && config.NUQ_RABBITMQ_URL);
  }

  private async deliver(
    payload: any,
    scrapeId?: string,
  ): Promise<Omit<WebhookSendResult, "attempted">> {
    const webhookHost = new URL(this.config.url).hostname;
    if (isIPPrivate(webhookHost) && config.ALLOW_LOCAL_WEBHOOKS !== true) {
      this.logger.warn("Aborting webhook call to private IP address", {
        webhookUrl: this.config.url,
      });
      return { delivered: false, skipped: true };
    }

    if (this.usesWebhookQueue()) {
      const queueMessage: WebhookQueueMessage = {
        webhook_url: this.config.url,
        payload,
        headers: this.config.headers,
        team_id: this.context.teamId,
        job_id: this.context.jobId,
        scrape_id: scrapeId ?? null,
        event: payload.type,
        timeout_ms: this.context.v0 ? 30000 : 10000,
      };

      try {
        await webhookQueue.publish(queueMessage, {
          zeroDataRetention: this.context.zeroDataRetention,
        });
        this.logger.info("Webhook queued for delivery", {
          webhookUrl: this.config.url,
          event: payload.type,
        });
      } catch (error) {
        this.logger.error("Failed to queue webhook", {
          error,
          webhookUrl: this.config.url,
        });
        throw error;
      }

      return { delivered: false, queued: true };
    }

    const payloadString = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers,
    };

    if (this.secret) {
      const hmac = createHmac("sha256", this.secret);
      hmac.update(payloadString);
      headers["X-Firecrawl-Signature"] = `sha256=${hmac.digest("hex")}`;
    }

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => {
        if (abortController) {
          abortController.abort();
        }
      },
      this.context.v0 ? 30000 : 10000,
    );

    try {
      const res = await undici.fetch(this.config.url, {
        method: "POST",
        headers,
        body: payloadString,
        dispatcher: getSecureDispatcherNoCookies(),
        signal: abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`Unexpected response status: ${res.status}`);
      }

      await logWebhook({
        success: res.status >= 200 && res.status < 300,
        teamId: this.context.teamId,
        crawlId: this.context.jobId, // this is legacy naming, we should rename it to jobId at some point
        scrapeId,
        url: this.config.url,
        event: payload.type,
        statusCode: res.status,
      });
      return { delivered: true, queued: false, statusCode: res.status };
    } catch (error) {
      this.logger.error("Failed to send webhook", {
        error,
        webhookUrl: this.config.url,
      });

      await logWebhook({
        success: false,
        teamId: this.context.teamId,
        crawlId: this.context.jobId, // same as above
        scrapeId,
        url: this.config.url,
        event: payload.type,
        error:
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : undefined,
        statusCode:
          typeof (error as any)?.status === "number"
            ? (error as any).status
            : undefined,
      });

      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  get metadata(): Record<string, string> {
    return this.config.metadata || {};
  }
}

export async function getWebhookInsertQueueLength(): Promise<number> {
  return (await redisEvictConnection.llen(WEBHOOK_INSERT_QUEUE_KEY)) ?? 0;
}

type WebhookLogRow = typeof schema.webhook_logs.$inferInsert;

// A row that Postgres rejects for its own contents (SQLSTATE class 22 data
// exception, 23 integrity constraint) will never succeed on retry. Anything
// else (connection errors, timeouts, shutdowns) is treated as transient.
// drizzle wraps the driver error, so the code lives on `cause`.
function isPermanentRowError(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && /^(22|23)/.test(code);
}

// Soft bound on how much a failing insert can push back onto the queue. The
// producers in logWebhook are not bounded, so this only stops requeues from
// piling onto an already long backlog.
async function requeueWebhookInsertJobs(rawJobs: string[]): Promise<void> {
  if (rawJobs.length === 0) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const queueLength =
        (await redisEvictConnection.llen(WEBHOOK_INSERT_QUEUE_KEY)) ?? 0;
      if (queueLength + rawJobs.length > WEBHOOK_INSERT_MAX_QUEUE_LENGTH) {
        _logger.error("Webhook insert queue is full, dropping webhook logs", {
          droppedCount: rawJobs.length,
          queueLength,
        });
        return;
      }
      // lpush adds each value to the head in turn, so reverse to keep the
      // original order at the front of the queue.
      await redisEvictConnection.lpush(
        WEBHOOK_INSERT_QUEUE_KEY,
        ...[...rawJobs].reverse(),
      );
      return;
    } catch (error) {
      if (attempt === 2) {
        _logger.error("Webhook inserter failed to requeue jobs", {
          error,
          jobCount: rawJobs.length,
        });
      }
    }
  }
}

export async function processWebhookInsertJobs() {
  const rawJobs =
    (await redisEvictConnection.lpop(
      WEBHOOK_INSERT_QUEUE_KEY,
      WEBHOOK_INSERT_BATCH_SIZE,
    )) ?? [];
  if (rawJobs.length === 0) return;

  // Parse each entry on its own so one malformed entry can't take the rest of
  // the batch down with it.
  const validRaw: string[] = [];
  const rows: WebhookLogRow[] = [];
  let malformedCount = 0;
  for (const raw of rawJobs) {
    try {
      rows.push(JSON.parse(raw));
      validRaw.push(raw);
    } catch {
      malformedCount++;
    }
  }
  if (malformedCount > 0) {
    _logger.error("Webhook inserter dropped malformed jobs", {
      malformedCount,
    });
  }
  if (rows.length === 0) return;

  _logger.info("Webhook inserter found jobs to insert", {
    jobCount: rows.length,
  });

  try {
    await db.insert(schema.webhook_logs).values(rows);
    _logger.info("Webhook inserter inserted jobs", { jobCount: rows.length });
    return;
  } catch (error) {
    _logger.error("Webhook inserter failed to insert jobs", {
      error,
      jobCount: rows.length,
    });
    if (!isPermanentRowError(error)) {
      // Most likely the database being unavailable, so try again next tick.
      await requeueWebhookInsertJobs(validRaw);
      return;
    }
  }

  // The database rejected something in the batch itself. Insert row by row so
  // one bad row can't keep failing the rest.
  let insertedCount = 0;
  let droppedCount = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      await db.insert(schema.webhook_logs).values(rows[i]);
      insertedCount++;
    } catch (error) {
      if (isPermanentRowError(error)) {
        droppedCount++;
      } else {
        // The database went away part way through: keep this row and
        // everything after it.
        await requeueWebhookInsertJobs(validRaw.slice(i));
        break;
      }
    }
  }
  if (droppedCount > 0) {
    _logger.error("Webhook inserter dropped rows the database rejected", {
      droppedCount,
      insertedCount,
    });
  }
}

async function logWebhook(data: {
  success: boolean;
  error?: string;
  teamId: string;
  crawlId: string;
  scrapeId?: string;
  url: string;
  statusCode?: number;
  event: WebhookEvent;
}): Promise<void> {
  try {
    await redisEvictConnection.rpush(
      WEBHOOK_INSERT_QUEUE_KEY,
      JSON.stringify({
        success: data.success,
        error: data.error ?? null,
        team_id: data.teamId,
        crawl_id: data.crawlId,
        scrape_id: data.scrapeId ?? null,
        url: data.url,
        status_code: data.statusCode ?? null,
        event: data.event,
      }),
    );
  } catch (error) {
    logger.error("Error logging webhook", {
      error,
      teamId: data.teamId,
    });
  }
}
