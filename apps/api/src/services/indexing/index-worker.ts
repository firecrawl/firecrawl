import "dotenv/config";
import { config } from "../../config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import * as Sentry from "@sentry/node";
import { Job, Queue, Worker } from "bullmq";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getRedisConnection,
  getBillingQueue,
} from "../queue-service";
import {
  processBillingBatch,
  queueBillingOperation,
  startBillingBatchProcessing,
} from "../billing/batch_billing";
import { resolveBillingMetadata } from "../billing/types";
import systemMonitor from "../system-monitor";
import { v7 as uuidv7 } from "uuid";
import {
  processIndexInsertJobs,
  processOMCEJobs,
} from "..";
import { getSearchIndexClient } from "../../lib/search-index-client";
// Search indexing is now handled by the separate search service
// import { processSearchIndexJobs } from "../../lib/search-index/queue";
import { processWebhookInsertJobs } from "../webhook";
import { processBrowserSessionActivityJobs } from "../../lib/browser-session-activity";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { supabase_service } from "../supabase";
import { processEngpickerJob } from "../../lib/engpicker";

const workerLockDuration = config.WORKER_LOCK_DURATION;
const workerStalledCheckInterval = config.WORKER_STALLED_CHECK_INTERVAL;
const jobLockExtendInterval = config.JOB_LOCK_EXTEND_INTERVAL;
const jobLockExtensionTime = config.JOB_LOCK_EXTENSION_TIME;

const cantAcceptConnectionInterval = config.CANT_ACCEPT_CONNECTION_INTERVAL;
const connectionMonitorInterval = config.CONNECTION_MONITOR_INTERVAL;
const gotJobInterval = config.CONNECTION_MONITOR_INTERVAL;

const runningJobs: Set<string> = new Set();

// Create a processor for billing jobs
const processBillingJobInternal = async (token: string, job: Job) => {
  if (!job.id) {
    throw new Error("Job has no ID");
  }

  const logger = _logger.child({
    module: "billing-worker",
    method: "processBillingJobInternal",
    jobId: job.id,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on billing job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  let err = null;
  try {
    // Check job type - it could be either a batch processing trigger or an individual billing operation
    if (job.name === "process-batch") {
      // Process the entire batch
      logger.info("Received batch process trigger job");
      await processBillingBatch();
    } else if (job.name === "bill_team") {
      // This is an individual billing operation that should be queued for batch processing
      const {
        team_id,
        subscription_id,
        credits,
        billing,
        endpoint,
        is_extract,
        api_key_id,
        autumnTrackInRequest,
      } =
        job.data;

      logger.info(`Adding team ${team_id} billing operation to batch queue`, {
        credits,
        is_extract,
        originating_job_id: job.data.originating_job_id,
      });

      // Add to the REDIS batch queue
      await queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id ?? null,
        resolveBillingMetadata({
          billing: billing ?? (endpoint ? { endpoint } : undefined),
          isExtract: is_extract,
        }),
        is_extract,
        autumnTrackInRequest,
      );
    } else {
      logger.warn(`Unknown billing job type: ${job.name}`);
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing billing job", { error });
    Sentry.captureException(error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }

  return err;
};

let isShuttingDown = false;

if (require.main === module) {
  process.on("SIGINT", () => {
    logger.info("Received SIGINT. Shutting down gracefully...");
    isShuttingDown = true;
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM. Shutting down gracefully...");
    isShuttingDown = true;
  });
}

let cantAcceptConnectionCount = 0;

// Generic worker function that can process different job types
const workerFun = async (
  queue: Queue,
  jobProcessor: (token: string, job: Job) => Promise<any>,
) => {
  const logger = _logger.child({ module: "index-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: getRedisConnection(),
    lockDuration: workerLockDuration,
    stalledInterval: workerStalledCheckInterval,
    maxStalledCount: 10,
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      logger.info("No longer accepting new jobs. SIGINT");
      break;
    }

    const token = uuidv7();
    const canAcceptConnection = await monitor.acceptConnection();

    if (!canAcceptConnection) {
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      if (cantAcceptConnectionCount >= 25) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
      }

      await new Promise(resolve =>
        setTimeout(resolve, cantAcceptConnectionInterval),
      );
      continue;
    } else {
      cantAcceptConnectionCount = 0;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      if (job.id) {
        runningJobs.add(job.id);
      }

      await jobProcessor(token, job);

      if (job.id) {
        runningJobs.delete(job.id);
      }

      await new Promise(resolve => setTimeout(resolve, gotJobInterval));
    } else {
      await new Promise(resolve =>
        setTimeout(resolve, connectionMonitorInterval),
      );
    }
  }

  logger.info("Worker loop ended. Waiting for running jobs to finish...");
  while (runningJobs.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  logger.info("All jobs finished. Worker exiting!");
  process.exit(0);
};

async function tallyBilling() {
  const logger = _logger.child({
    module: "index-worker",
    method: "tallyBilling",
  });
  // get up to 100 teams and remove them from set
  const billedTeams = await getRedisConnection().srandmember(
    "billed_teams",
    100,
  );

  if (!billedTeams || billedTeams.length === 0) {
    logger.debug("No billed teams to process");
    return;
  }

  await getRedisConnection().srem("billed_teams", billedTeams);
  logger.info("Starting to update tallies", {
    billedTeams: billedTeams.length,
  });

  for (const teamId of billedTeams) {
    logger.info("Updating tally for team", { teamId });

    const { error } = await supabase_service.rpc("update_tally_10_team", {
      i_team_id: teamId,
    });

    if (error) {
      logger.warn("Failed to update tally for team", { teamId, error });
    } else {
      logger.info("Updated tally for team", { teamId });
    }
  }

  logger.info("Finished updating tallies");
}

const INDEX_INSERT_INTERVAL = 3000;
const WEBHOOK_INSERT_INTERVAL = 15000;
const OMCE_INSERT_INTERVAL = 5000;
const BROWSER_ACTIVITY_INSERT_INTERVAL = 10000;
// Search indexing is now handled by separate search service, not this worker
// const SEARCH_INDEX_INTERVAL = 10000;

// Start the workers
(async () => {
  setSentryServiceTag("index-worker");

  // Start billing worker and batch processing
  startBillingBatchProcessing();
  const billingWorkerPromise = workerFun(
    getBillingQueue(),
    processBillingJobInternal,
  );

  const indexInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }

    await withSpan("firecrawl-index-worker-process-insert-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_insert_jobs",
        "index.worker.type": "scheduled",
      });
      await processIndexInsertJobs();
    });
  }, INDEX_INSERT_INTERVAL);

  const webhookInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processWebhookInsertJobs();
  }, WEBHOOK_INSERT_INTERVAL);

  const browserActivityInterval = setInterval(async () => {
    if (isShuttingDown) return;
    await processBrowserSessionActivityJobs();
  }, BROWSER_ACTIVITY_INSERT_INTERVAL);

  const omceInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan("firecrawl-index-worker-process-omce-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_omce_jobs",
        "index.worker.type": "scheduled",
      });
      await processOMCEJobs();
    });
  }, OMCE_INSERT_INTERVAL);

  const billingTallyInterval = setInterval(
    async () => {
      if (isShuttingDown) {
        return;
      }
      await tallyBilling();
    },
    5 * 60 * 1000,
  );

  const engpickerPromise = (async () => {
    if (config.DISABLE_ENGPICKER) {
      logger.info("Engpicker is disabled, skipping");
      return;
    }

    while (!isShuttingDown) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        await processEngpickerJob();
      } catch (e) {
        logger.error("Error processing engpicker job", { error: e });
      }
    }
  })();

  // Search indexing is now handled by separate search service
  // The search service has its own worker that processes the queue
  // This worker no longer needs to process search index jobs

  // Health check for search service (optional)
  const searchClient = getSearchIndexClient();
  if (searchClient) {
    searchClient
      .health()
      .then(healthy => {
        if (healthy) {
          logger.info("Search service is healthy");
        } else {
          logger.warn("Search service health check failed");
        }
      })
      .catch(error => {
        logger.error("Search service health check error", { error });
      });
  }

  // Wait for all workers to complete (which should only happen on shutdown)
  await Promise.all([
    billingWorkerPromise,
    engpickerPromise,
  ]);

  clearInterval(indexInserterInterval);
  clearInterval(webhookInserterInterval);
  clearInterval(browserActivityInterval);
  clearInterval(omceInserterInterval);
  clearInterval(billingTallyInterval);
  logger.info("All workers shut down, exiting process");
})();
