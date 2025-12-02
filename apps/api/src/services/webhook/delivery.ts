import undici from "undici";
import { createHmac } from "crypto";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getSecureDispatcher,
  isIPPrivate,
} from "../../scraper/scrapeURL/engines/utils/safeFetch";
import { WebhookConfig, WebhookEvent, WebhookEventDataMap } from "./types";
import { redisEvictConnection } from "../redis";
import { supabase_service } from "../supabase";

const WEBHOOK_INSERT_QUEUE_KEY = "webhook-insert-queue";
const WEBHOOK_INSERT_BATCH_SIZE = 1000;

export class WebhookSender {
  private config: WebhookConfig;
  private secret?: string;
  private context: { teamId: string; jobId: string; v0: boolean };
  private logger: any;

  constructor(
    config: WebhookConfig,
    secret: string | undefined,
    context: { teamId: string; jobId: string; v0: boolean },
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
  ): Promise<void> {
    if (!this.shouldSendEvent(event)) return;

    const payload = {
      success: data.success,
      type: event,
      [this.context.v0 ? "jobId" : "id"]: this.context.jobId,
      data: "data" in data ? data.data : [],
      error: "error" in data ? data.error : undefined,
      metadata: this.config.metadata || undefined,
    };

    const delivery = this.deliver(
      payload,
      (data as any)?.scrapeId ?? undefined,
    );

    if (data.awaitWebhook) {
      await delivery;
    } else {
      delivery.catch(() => {});
    }
  }

  private shouldSendEvent(event: WebhookEvent): boolean {
    if (process.env.DISABLE_WEBHOOK_DELIVERY === "true") {
      return false;
    }

    if (!this.config.events?.length) {
      return true;
    }

    const subType = event.split(".")[1];
    return this.config.events.includes(subType as any);
  }

  private async deliver(payload: any, scrapeId?: string): Promise<void> {
    const webhookHost = new URL(this.config.url).hostname;
    if (
      isIPPrivate(webhookHost) &&
      process.env.ALLOW_LOCAL_WEBHOOKS !== "true"
    ) {
      this.logger.warn("Aborting webhook call to private IP address", {
        webhookUrl: this.config.url,
      });
      return;
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
        dispatcher: getSecureDispatcher(),
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

export async function processWebhookInsertJobs() {
  const jobs =
    (await redisEvictConnection.lpop(
      WEBHOOK_INSERT_QUEUE_KEY,
      WEBHOOK_INSERT_BATCH_SIZE,
    )) ?? [];
  if (jobs.length === 0) return;

  const parsedJobs = jobs.map(x => JSON.parse(x));
  _logger.info("Webhook inserter found jobs to insert", {
    jobCount: parsedJobs.length,
  });

  try {
    await supabase_service.from("webhook_logs").insert(parsedJobs);
    _logger.info("Webhook inserter inserted jobs", {
      jobCount: parsedJobs.length,
    });
  } catch (error) {
    _logger.error("Webhook inserter failed to insert jobs", {
      error,
      jobCount: parsedJobs.length,
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
