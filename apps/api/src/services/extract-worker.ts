import "dotenv/config";
import { config } from "../config";
import "./sentry";
import { setSentryServiceTag } from "./sentry";
import * as Sentry from "@sentry/node";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import { ExtractResult } from "../lib/extract/extraction-service";
import { updateExtract } from "../lib/extract/extract-redis";
import { performExtraction_F0 } from "../lib/extract/fire-0/extraction-service-f0";
import { createWebhookSender, WebhookEvent } from "./webhook";
import Express from "express";
import { getErrorContactMessage } from "../lib/deployment";
import { TransportableError } from "../lib/error";
import { initializeBlocklist } from "../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../scraper/WebScraper/utils/engine-forcing";
import {
  consumeExtractJobs,
  consumeExtractDLQ,
  shutdownExtractQueue,
  ExtractJobData,
} from "./extract-queue";
import { logExtract } from "./logging/log_job";
import { jobDurationSeconds } from "../lib/job-metrics";
import { register } from "prom-client";

configDotenv();

const processExtractJob = async (
  data: ExtractJobData,
  ack: () => void,
  nack: () => void,
) => {
  const logger = _logger.child({
    module: "extract-worker",
    method: "processExtractJob",
    extractId: data.extractId,
    teamId: data.teamId,
  });

  const sender = await createWebhookSender({
    teamId: data.teamId,
    jobId: data.extractId,
    webhook: data.request.webhook,
    v0: false,
  });

  const endJobTimer = jobDurationSeconds.startTimer({ type: "extract" });

  try {
    if (sender) {
      sender.send(WebhookEvent.EXTRACT_STARTED, {
        success: true,
      });
    }

    let result: ExtractResult | null = null;

    result = await performExtraction_F0(data.extractId, {
      request: data.request,
      teamId: data.teamId,
      subId: data.subId ?? undefined,
      apiKeyId: data.apiKeyId ?? null,
    });

    if (result && result.success) {
      await updateExtract(data.extractId, {
        status: "completed",
        llmUsage: result.llmUsage,
        sources: result.sources,
        tokensBilled: result.tokensBilled,
        creditsBilled: result.creditsBilled,
      });

      if (sender) {
        sender.send(WebhookEvent.EXTRACT_COMPLETED, {
          success: true,
          data: [result],
        });
      }

      endJobTimer({ status: "success" });
      ack();
      return;
    } else {
      await updateExtract(data.extractId, {
        status: "failed",
        error: result?.error ?? getErrorContactMessage(data.extractId),
      });

      if (sender) {
        sender.send(WebhookEvent.EXTRACT_FAILED, {
          success: false,
          error: result?.error ?? getErrorContactMessage(data.extractId),
        });
      }

      endJobTimer({ status: "failed" });
      ack();
      return;
    }
  } catch (error) {
    endJobTimer({ status: "failed" });
    logger.error(`🚫 Extract job errored ${data.extractId} - ${error}`, {
      error,
    });

    // Filter out TransportableErrors (flow control)
    if (!(error instanceof TransportableError)) {
      Sentry.captureException(error, {
        data: {
          extractId: data.extractId,
        },
      });
    }

    await updateExtract(data.extractId, {
      status: "failed",
      error:
        (error as any)?.error ??
        (error as any)?.message ??
        getErrorContactMessage(data.extractId),
    });

    if (sender) {
      sender.send(WebhookEvent.EXTRACT_FAILED, {
        success: false,
        error:
          (error as any)?.message ?? getErrorContactMessage(data.extractId),
      });
    }

    // Ack the message even on error - we've handled it and updated the DB
    // Only nack if we want to send to DLX (which we don't for handled errors)
    ack();
  }
};

const processDLQJob = async (data: ExtractJobData) => {
  const logger = _logger.child({
    module: "extract-dlq",
    extractId: data.extractId,
    teamId: data.teamId,
  });

  logger.error("Processing crashed extract job from DLQ");

  // Update the extract status to failed in the database
  await updateExtract(data.extractId, {
    status: "failed",
    error:
      "Extract job crashed unexpectedly. Please try again or contact support if the issue persists.",
  });

  await logExtract({
    id: data.extractId,
    request_id: data.extractId,
    urls: data.request.urls,
    team_id: data.teamId,
    options: data.request,
    model_kind: data.request.agent?.model ?? "fire-0",
    credits_cost: 0,
    is_successful: false,
    error:
      "Extract job crashed unexpectedly. Please try again or contact support if the issue persists.",
    cost_tracking: undefined,
  });

  // Send webhook notification
  const sender = await createWebhookSender({
    teamId: data.teamId,
    jobId: data.extractId,
    webhook: data.request.webhook,
    v0: false,
  });

  if (sender) {
    sender.send(WebhookEvent.EXTRACT_FAILED, {
      success: false,
      error:
        "Extract job crashed unexpectedly. Please try again or contact support if the issue persists.",
    });
  }

  logger.info("DLQ job processed - extract marked as failed");
};

// Start the worker
const app = Express();

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});
app.get("/liveness", (req, res) => {
  res.status(200).json({ ok: true });
});
app.get("/metrics", async (_, res) => {
  res.contentType("text/plain").send(await register.metrics());
});

const workerPort = config.EXTRACT_WORKER_PORT || config.PORT;
app.listen(workerPort, () => {
  _logger.info(
    `Extract worker health endpoint is running on port ${workerPort}`,
  );
});

async function shutdown() {
  _logger.info("Shutting down extract worker...");
  await shutdownExtractQueue();
  _logger.info("Extract worker shut down");
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

(async () => {
  setSentryServiceTag("extract-worker");

  await initializeBlocklist().catch(e => {
    _logger.error("Failed to initialize blocklist", { error: e });
    process.exit(1);
  });

  initializeEngineForcing();

  _logger.info("Starting extract worker with RabbitMQ...");

  // Start consuming from both the main queue and the DLQ
  await Promise.all([
    consumeExtractJobs(processExtractJob),
    consumeExtractDLQ(processDLQJob),
  ]);

  _logger.info("Extract worker started, consuming from RabbitMQ");
})();
