import "dotenv/config";
import { config } from "../config";
import "./sentry";
import { setSentryServiceTag } from "./sentry";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import Express from "express";
import undici from "undici";
import { createHmac } from "crypto";
import {
  consumeWebhookJobs,
  consumeWebhookDLQ,
  shutdownWebhookConsumerQueue,
} from "./webhook-consumer-queue";
import { logWebhook } from "./webhook/delivery";
import type { WebhookQueueMessage } from "./webhook/types";
import {
  getSecureDispatcherNoCookies,
  isIPPrivate,
} from "../scraper/scrapeURL/engines/utils/safeFetch";
import { supabase_rr_service } from "./supabase";
import { Counter, Histogram, register } from "prom-client";

configDotenv();

// --- Prometheus metrics ---

const webhookDeliveryDuration = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Duration of webhook HTTP delivery in seconds",
  labelNames: ["status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

const webhookDeliveryTotal = new Counter({
  name: "webhook_delivery_total",
  help: "Total webhook deliveries by outcome",
  labelNames: ["status"],
});

// --- HMAC secret cache ---

const hmacSecretCache = new Map<
  string,
  { secret: string | undefined; expiresAt: number }
>();
const HMAC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getHmacSecret(teamId: string): Promise<string | undefined> {
  if (config.USE_DB_AUTHENTICATION !== true) {
    return config.SELF_HOSTED_WEBHOOK_HMAC_SECRET;
  }

  const cached = hmacSecretCache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) return cached.secret;

  try {
    const { data, error } = await supabase_rr_service
      .from("teams")
      .select("hmac_secret")
      .eq("id", teamId)
      .limit(1)
      .single();

    const secret = error ? undefined : data?.hmac_secret;
    hmacSecretCache.set(teamId, {
      secret,
      expiresAt: Date.now() + HMAC_CACHE_TTL_MS,
    });
    return secret;
  } catch {
    return undefined;
  }
}

// --- Retry helpers ---

function isRetryable(statusCode: number | undefined, error: unknown): boolean {
  if (!statusCode) {
    // Network error / timeout — check if retryable
    const msg = error instanceof Error ? error.message : String(error ?? "");
    // DNS resolution failures are permanent
    if (msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN")) return false;
    // Everything else (ECONNREFUSED, ETIMEDOUT, ECONNRESET, abort) is retryable
    return true;
  }
  return statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

function isPermanentFailure(
  statusCode: number | undefined,
  error: unknown,
): boolean {
  if (!statusCode) {
    const msg = error instanceof Error ? error.message : String(error ?? "");
    return msg.includes("ENOTFOUND") || msg.includes("EAI_AGAIN");
  }
  return (
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429 &&
    statusCode !== 408
  );
}

// --- Core delivery function ---

async function deliverWebhook(
  msg: WebhookQueueMessage,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  // SSRF protection
  let webhookHost: string;
  try {
    webhookHost = new URL(msg.webhook_url).hostname;
  } catch {
    return { success: false, error: "Invalid webhook URL" };
  }

  if (isIPPrivate(webhookHost) && config.ALLOW_LOCAL_WEBHOOKS !== true) {
    return { success: false, error: "Private IP address rejected" };
  }

  // HMAC signing
  const secret = await getHmacSecret(msg.team_id);
  const payloadString = JSON.stringify(msg.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...msg.headers,
  };

  if (secret) {
    const hmac = createHmac("sha256", secret);
    hmac.update(payloadString);
    headers["X-Firecrawl-Signature"] = `sha256=${hmac.digest("hex")}`;
  }

  const timeoutMs = msg.timeout_ms || 10000;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const res = await undici.fetch(msg.webhook_url, {
      method: "POST",
      headers,
      body: payloadString,
      dispatcher: getSecureDispatcherNoCookies(),
      signal: abortController.signal,
    });

    // Consume the response body to free the socket
    await res.text().catch(() => {});

    return {
      success: res.status >= 200 && res.status < 300,
      statusCode: res.status,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// --- Main job handler ---

const RETRY_BASE_DELAY_MS = 1000;

const processWebhookJob = async (
  msg: WebhookQueueMessage,
  ack: () => void,
  nack: () => void,
) => {
  const maxRetries = config.WEBHOOK_MAX_RETRIES;
  const logger = _logger.child({
    module: "webhook-worker",
    jobId: msg.job_id,
    teamId: msg.team_id,
    event: msg.event,
    scrapeId: msg.scrape_id,
    webhookUrl: msg.webhook_url,
  });

  let lastResult: {
    success: boolean;
    statusCode?: number;
    error?: string;
  } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.info("Retrying webhook delivery", {
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        delayMs: delay,
      });
      await new Promise(r => setTimeout(r, delay));
    }

    const endTimer = webhookDeliveryDuration.startTimer();
    lastResult = await deliverWebhook(msg);

    if (lastResult.success) {
      endTimer({ status: "success" });
      webhookDeliveryTotal.inc({ status: "success" });

      logger.info("Webhook delivered successfully", {
        statusCode: lastResult.statusCode,
        attempt: attempt + 1,
      });

      await logWebhook({
        success: true,
        teamId: msg.team_id,
        crawlId: msg.job_id,
        scrapeId: msg.scrape_id ?? undefined,
        url: msg.webhook_url,
        event: msg.event as any,
        statusCode: lastResult.statusCode,
      });

      ack();
      return;
    }

    endTimer({ status: "failure" });

    // Permanent failure (4xx except 429/408, DNS not found) — don't retry
    if (isPermanentFailure(lastResult.statusCode, lastResult.error)) {
      logger.warn("Webhook permanently failed, not retrying", {
        statusCode: lastResult.statusCode,
        error: lastResult.error,
        attempt: attempt + 1,
      });
      break;
    }

    // Not retryable — break
    if (!isRetryable(lastResult.statusCode, lastResult.error)) {
      logger.warn("Webhook failed with non-retryable error", {
        statusCode: lastResult.statusCode,
        error: lastResult.error,
        attempt: attempt + 1,
      });
      break;
    }

    // Retryable — continue loop
    logger.warn("Webhook delivery failed (retryable)", {
      statusCode: lastResult.statusCode,
      error: lastResult.error,
      attempt: attempt + 1,
    });
  }

  // All retries exhausted or permanent failure
  webhookDeliveryTotal.inc({ status: "failure" });

  logger.error("Webhook delivery failed permanently", {
    statusCode: lastResult?.statusCode,
    error: lastResult?.error,
  });

  await logWebhook({
    success: false,
    teamId: msg.team_id,
    crawlId: msg.job_id,
    scrapeId: msg.scrape_id ?? undefined,
    url: msg.webhook_url,
    event: msg.event as any,
    statusCode: lastResult?.statusCode,
    error: lastResult?.error,
  });

  // Send to DLQ
  nack();
};

// --- DLQ handler ---

const processDLQJob = async (msg: WebhookQueueMessage) => {
  const logger = _logger.child({
    module: "webhook-dlq",
    jobId: msg.job_id,
    teamId: msg.team_id,
    event: msg.event,
  });

  logger.error("Webhook permanently failed (DLQ)", {
    url: msg.webhook_url,
    event: msg.event,
  });

  // Log the final failure to webhook_logs
  await logWebhook({
    success: false,
    teamId: msg.team_id,
    crawlId: msg.job_id,
    scrapeId: msg.scrape_id ?? undefined,
    url: msg.webhook_url,
    event: msg.event as any,
    error: "Permanently failed after max retries (DLQ)",
  });
};

// --- Express health/metrics server ---

const app = Express();

app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/liveness", (_req, res) => res.status(200).json({ ok: true }));
app.get("/metrics", async (_req, res) => {
  res.contentType("text/plain").send(await register.metrics());
});

const workerPort = config.WEBHOOK_WORKER_PORT;
app.listen(workerPort, () => {
  _logger.info(`Webhook worker health endpoint on port ${workerPort}`);
});

// --- Graceful shutdown ---

async function shutdown() {
  _logger.info("Shutting down webhook worker...");
  await shutdownWebhookConsumerQueue();
  _logger.info("Webhook worker shut down");
  process.exit(0);
}

if (require.main === module) {
  process.on("SIGINT", () => {
    _logger.debug("Received SIGINT. Shutting down gracefully...");
    shutdown();
  });

  process.on("SIGTERM", () => {
    _logger.debug("Received SIGTERM. Shutting down gracefully...");
    shutdown();
  });
}

// --- Start ---

(async () => {
  setSentryServiceTag("webhook-worker");

  _logger.info("Starting webhook worker with RabbitMQ...");

  await Promise.all([
    consumeWebhookJobs(processWebhookJob),
    consumeWebhookDLQ(processDLQJob),
  ]);

  _logger.info("Webhook worker started, consuming from RabbitMQ");
})();
