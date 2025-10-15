import "dotenv/config";
import { shutdownOtel } from "../otel";
import "./sentry";
import * as Sentry from "@sentry/node";
import { getExtractQueue, getRedisConnection } from "./queue-service";
import { Job, Queue, Worker } from "bullmq";
import { logger as _logger } from "../lib/logger";
import systemMonitor from "./system-monitor";
import { v4 as uuidv4 } from "uuid";
import { configDotenv } from "dotenv";
import {
  ExtractResult,
  performExtraction,
} from "../lib/extract/extraction-service";
import { updateExtract } from "../lib/extract/extract-redis";
import { performExtraction_F0 } from "../lib/extract/fire-0/extraction-service-f0";
import { createWebhookSender, WebhookEvent } from "./webhook";
import Express from "express";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { BullMQOtel } from "bullmq-otel";
import { getErrorContactMessage } from "../lib/deployment";
import { initializeBlocklist } from "../scraper/WebScraper/utils/blocklist";

configDotenv();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 10000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

const runningJobs: Set<string> = new Set();

const processExtractJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "extract-worker",
    method: "processJobInternal",
    jobId: job.id,
    extractId: job.data.extractId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  const sender = await createWebhookSender({
    teamId: job.data.teamId,
    jobId: job.data.extractId,
    webhook: job.data.request.webhook,
    v0: false,
  });

  try {
    if (sender) {
      sender.send(WebhookEvent.EXTRACT_STARTED, {
        success: true,
      });
    }

    let result: ExtractResult | null = null;

    const model = job.data.request.agent?.model;
    if (
      job.data.request.agent &&
      model &&
      model.toLowerCase().includes("fire-1")
    ) {
      result = await performExtraction(job.data.extractId, {
        request: job.data.request,
        teamId: job.data.teamId,
        subId: job.data.subId,
        apiKeyId: job.data.apiKeyId,
      });
    } else {
      result = await performExtraction_F0(job.data.extractId, {
        request: job.data.request,
        teamId: job.data.teamId,
        subId: job.data.subId,
        apiKeyId: job.data.apiKeyId,
      });
    }
    // result = await performExtraction_F0(job.data.extractId, {
    //   request: job.data.request,
    //   teamId: job.data.teamId,
    //   subId: job.data.subId,
    // });

    if (result && result.success) {
      // Move job to completed state in Redis
      await job.moveToCompleted(result, token, false);

      if (sender) {
        sender.send(WebhookEvent.EXTRACT_COMPLETED, {
          success: true,
          data: [result],
        });
      }

      return result;
    } else {
      // throw new Error(result.error || "Unknown error during extraction");

      await job.moveToCompleted(result, token, false);
      await updateExtract(job.data.extractId, {
        error: result?.error ?? getErrorContactMessage(job.data.extractId),
      });

      if (sender) {
        sender.send(WebhookEvent.EXTRACT_FAILED, {
          success: false,
          error: result?.error ?? getErrorContactMessage(job.data.extractId),
        });
      }

      return result;
    }
  } catch (error) {
    logger.error(`🚫 Job errored ${job.id} - ${error}`, { error });

    Sentry.captureException(error, {
      data: {
        job: job.id,
      },
    });

    try {
      // Move job to failed state in Redis
      await job.moveToFailed(error, token, false);
    } catch (e) {
      logger.log("Failed to move job to failed state in Redis", { error });
    }

    await updateExtract(job.data.extractId, {
      status: "failed",
      error: error.error ?? error ?? getErrorContactMessage(job.data.extractId),
    });

    if (sender) {
      sender.send(WebhookEvent.EXTRACT_FAILED, {
        success: false,
        error:
          (error as any)?.message ?? getErrorContactMessage(job.data.extractId),
      });
    }

    return {
      success: false,
      error: error.error ?? error ?? getErrorContactMessage(job.data.extractId),
    };
    // throw error;
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;
let isWorkerStalled = false;

process.on("SIGINT", () => {
  _logger.debug("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  _logger.debug("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

const workerFun = async (
  queue: Queue,
  processJobInternal: (token: string, job: Job) => Promise<any>,
) => {
  const logger = _logger.child({ module: "queue-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: getRedisConnection(),
    lockDuration: 60 * 1000, // 60 seconds
    stalledInterval: 60 * 1000, // 60 seconds
    maxStalledCount: 10, // 10 times
    telemetry: new BullMQOtel("firecrawl-bullmq"),
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      _logger.info("No longer accepting new jobs. SIGINT");
      break;
    }
    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    if (!canAcceptConnection) {
      console.log("Can't accept connection due to RAM/CPU load");
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      isWorkerStalled = cantAcceptConnectionCount >= 25;

      if (isWorkerStalled) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
      }

      await sleep(cantAcceptConnectionInterval); // more sleep
      continue;
    } else if (!currentLiveness) {
      logger.info("Not accepting jobs because the liveness check failed");

      await sleep(cantAcceptConnectionInterval);
      continue;
    } else {
      cantAcceptConnectionCount = 0;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      if (job.id) {
        runningJobs.add(job.id);
      }

      processJobInternal(token, job).finally(() => {
        if (job.id) {
          runningJobs.delete(job.id);
        }
      });

      await sleep(gotJobInterval);
    } else {
      await sleep(connectionMonitorInterval);
    }
  }
};

// Start all workers
const app = Express();

let currentLiveness: boolean = true;

app.get("/liveness", (req, res) => {
  _logger.info("Liveness endpoint hit");
  if (process.env.USE_DB_AUTHENTICATION === "true") {
    // networking check for Kubernetes environments
    const host = process.env.FIRECRAWL_APP_HOST || "firecrawl-app-service";
    const port = process.env.FIRECRAWL_APP_PORT || "3002";
    const scheme = process.env.FIRECRAWL_APP_SCHEME || "http";

    robustFetch({
      url: `${scheme}://${host}:${port}`,
      method: "GET",
      mock: null,
      logger: _logger,
      abort: AbortSignal.timeout(5000),
      ignoreResponse: true,
      useCacheableLookup: false,
    })
      .then(() => {
        currentLiveness = true;
        res.status(200).json({ ok: true });
      })
      .catch(e => {
        _logger.error("WORKER NETWORKING CHECK FAILED", { error: e });
        currentLiveness = false;
        res.status(500).json({ ok: false });
      });
  } else {
    currentLiveness = true;
    res.status(200).json({ ok: true });
  }
});

const workerPort = process.env.EXTRACT_WORKER_PORT || process.env.PORT || 3005;
app.listen(workerPort, () => {
  _logger.info(`Liveness endpoint is running on port ${workerPort}`);
});

(async () => {
  await initializeBlocklist().catch(e => {
    _logger.error("Failed to initialize blocklist", { error: e });
    process.exit(1);
  });

  await Promise.all([workerFun(getExtractQueue(), processExtractJobInternal)]);

  _logger.info("All workers exited. Waiting for all jobs to finish...");

  while (runningJobs.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  _logger.info("All jobs finished. Shutting down...");
  shutdownOtel().finally(() => {
    _logger.debug("OTEL shutdown");
    process.exit(0);
  });
})();
