import undici from "undici";
import { logger as _logger, logger } from "../lib/logger";
import { supabase_rr_service, supabase_service } from "./supabase";
import { WebhookEventType } from "../types";
import { configDotenv } from "dotenv";
import { z } from "zod";
import { webhookSchema } from "../controllers/v1/types";
import { redisEvictConnection } from "./redis";
import { createHmac } from "crypto";
import {
  getSecureDispatcher,
  isIPPrivate,
} from "../scraper/scrapeURL/engines/utils/safeFetch";
configDotenv();

const WEBHOOK_INSERT_QUEUE_KEY = "webhook-insert-queue";
const WEBHOOK_INSERT_BATCH_SIZE = 1000;

interface WebhookLogData {
  success: boolean;
  error?: string;
  teamId: string;
  crawlId: string;
  scrapeId?: string;
  url: string;
  statusCode?: number;
  event: WebhookEventType;
}

interface CallWebhookParams {
  teamId: string;
  crawlId: string;
  scrapeId?: string;
  webhook?: z.infer<typeof webhookSchema>;
  v1: boolean;
  data: any | null;
  eventType: WebhookEventType;
  awaitWebhook?: boolean;
}

async function addWebhookInsertJob(data: any) {
  await redisEvictConnection.rpush(
    WEBHOOK_INSERT_QUEUE_KEY,
    JSON.stringify(data),
  );
}

export async function getWebhookInsertQueueLength(): Promise<number> {
  return (await redisEvictConnection.llen(WEBHOOK_INSERT_QUEUE_KEY)) ?? 0;
}

async function getWebhookInsertJobs(): Promise<any[]> {
  const jobs =
    (await redisEvictConnection.lpop(
      WEBHOOK_INSERT_QUEUE_KEY,
      WEBHOOK_INSERT_BATCH_SIZE,
    )) ?? [];
  return jobs.map((x) => JSON.parse(x));
}

export async function processWebhookInsertJobs() {
  const jobs = await getWebhookInsertJobs();
  if (jobs.length === 0) {
    return;
  }
  logger.info(`Webhook inserter found jobs to insert`, {
    jobCount: jobs.length,
  });
  try {
    await supabase_service.from("webhook_logs").insert(jobs);
    logger.info(`Webhook inserter inserted jobs`, { jobCount: jobs.length });
  } catch (error) {
    logger.error(`Webhook inserter failed to insert jobs`, {
      error,
      jobCount: jobs.length,
    });
  }
}

async function logWebhook(data: WebhookLogData) {
  try {
    await addWebhookInsertJob({
      success: data.success,
      error: data.error ?? null,
      team_id: data.teamId,
      crawl_id: data.crawlId,
      scrape_id: data.scrapeId ?? null,
      url: data.url,
      status_code: data.statusCode ?? null,
      event: data.event,
    });
  } catch (error) {
    _logger.error("Error logging webhook", {
      error,
      crawlId: data.crawlId,
      scrapeId: data.scrapeId,
      teamId: data.teamId,
      team_id: data.teamId,
      module: "webhook",
      method: "logWebhook",
    });
  }
}

function generateHmacSignature(payload: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload);
  return hmac.digest("hex");
}

export const callWebhook = async ({
  teamId,
  crawlId,
  scrapeId,
  data,
  webhook,
  v1,
  eventType,
  awaitWebhook = false,
}: CallWebhookParams) => {
  const logger = _logger.child({
    module: "webhook",
    method: "callWebhook",
    teamId,
    team_id: teamId,
    crawlId,
    scrapeId,
    eventType,
    awaitWebhook,
    webhook,
    isV1: v1,
  });

  if (webhook) {
    let subType = eventType.split(".")[1];
    if (!webhook.events.includes(subType as any)) {
      logger.debug("Webhook event type not in specified events", {
        subType,
        webhook,
      });
      return false;
    }
  }

  try {
    const selfHostedUrl = process.env.SELF_HOSTED_WEBHOOK_URL?.replace(
      "{{JOB_ID}}",
      crawlId,
    );
    const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
    let webhookUrl =
      webhook ??
      (selfHostedUrl ? webhookSchema.parse({ url: selfHostedUrl }) : undefined);

    // TODO: do these queries upstream so we don't have to query the DB multiple times per crawl

    // Only fetch the webhook URL from the database if the self-hosted webhook URL and specified webhook are not set
    // and the USE_DB_AUTHENTICATION environment variable is set to true
    if (!webhookUrl && useDbAuthentication) {
      const { data: webhooksData, error } = await supabase_rr_service
        .from("webhooks")
        .select("url")
        .eq("team_id", teamId)
        .limit(1);
      if (error) {
        logger.error(`Error fetching webhook URL for team`, {
          error,
        });
        return null;
      }

      if (!webhooksData || webhooksData.length === 0) {
        return null;
      }

      webhookUrl = webhooksData[0].url;
    }

    let hmacSecret: string | undefined =
      process.env.SELF_HOSTED_WEBHOOK_HMAC_SECRET;
    if (useDbAuthentication) {
      const { data: teamData, error: teamError } = await supabase_rr_service
        .from("teams")
        .select("hmac_secret")
        .eq("id", teamId)
        .limit(1)
        .single();

      if (teamError) {
        logger.error(`Error fetching team HMAC secret`, {
          error: teamError,
        });
      }

      if (teamData?.hmac_secret) hmacSecret = teamData.hmac_secret;
    }

    logger.debug("Calling webhook...", {
      webhookUrl,
    });

    if (!webhookUrl) {
      return null;
    }

    // check if the webhook URL is a private IP address *before* making the request
    // the dispatcher also performs a check once connected, however this prevents unnecessary connections
    const webhookHost = new URL(webhookUrl.url).hostname;
    if (isIPPrivate(webhookHost)) {
      logger.warn("Aborting webhook call to private IP address", {
        url: webhookUrl.url,
      });
      return null;
    }

    let dataToSend: any[] = [];
    if (
      data &&
      data.result &&
      data.result.links &&
      data.result.links.length !== 0
    ) {
      for (let i = 0; i < data.result.links.length; i++) {
        if (v1) {
          dataToSend.push(data.result.links[i].content);
        } else {
          dataToSend.push({
            content: data.result.links[i].content.content,
            markdown: data.result.links[i].content.markdown,
            metadata: data.result.links[i].content.metadata,
          });
        }
      }
    }

    const payload = {
      success: !v1
        ? data.success
        : eventType === "crawl.page"
          ? data.success
          : true,
      type: eventType,
      [v1 ? "id" : "jobId"]: crawlId,
      data: dataToSend,
      error: !v1
        ? data?.error || undefined
        : eventType === "crawl.page"
          ? data?.error || undefined
          : undefined,
      metadata: webhookUrl.metadata || undefined,
    };

    const payloadString = JSON.stringify(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...webhookUrl.headers,
    };

    if (hmacSecret) {
      const signature = generateHmacSignature(payloadString, hmacSecret);
      headers["X-Firecrawl-Signature"] = `sha256=${signature}`;
    }

    const executeWebhookRequest = async () => {
      try {
        const res = await undici.fetch(webhookUrl.url, {
          method: "POST",
          headers,
          body: payloadString,
          dispatcher: getSecureDispatcher(),
          signal: AbortSignal.timeout(v1 ? 10000 : 30000), // 10 seconds timeout (v1)
        });

        if (!res.ok) {
          throw { status: res.status };
        }

        logWebhook({
          success: res.status >= 200 && res.status < 300,
          teamId,
          crawlId,
          scrapeId,
          url: webhookUrl.url,
          event: eventType,
          statusCode: res.status,
        });

        return res;
      } catch (error) {
        logger.error(`Failed to send webhook`, {
          error,
        });

        logWebhook({
          success: false,
          teamId,
          crawlId,
          scrapeId,
          url: webhookUrl.url,
          event: eventType,
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
      }
    };

    if (awaitWebhook) {
      await executeWebhookRequest();
    } else {
      executeWebhookRequest().catch(() => {
        // already logged in executeWebhookRequest
      });
    }
  } catch (error) {
    logger.warn(`Error sending webhook`, {
      error,
    });
  }
};
