import "dotenv/config";
import "../sentry";
import * as Sentry from "@sentry/node";
import { Job, Queue, Worker } from "bullmq";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getRedisConnection,
  getBillingQueue,
  getPrecrawlQueue,
  precrawlQueueName,
} from "../queue-service";
import { processBillingBatch, queueBillingOperation, startBillingBatchProcessing } from "../billing/batch_billing";
import systemMonitor from "../system-monitor";
import { v4 as uuidv4 } from "uuid";
import { index_supabase_service, processIndexInsertJobs, processIndexRFInsertJobs, processOMCEJobs, processDomainFrequencyJobs } from "..";
import { processWebhookInsertJobs } from "../webhook";
import { scrapeOptions as scrapeOptionsSchema, crawlRequestSchema, toV0CrawlerOptions } from "../../controllers/v2/types";
import { StoredCrawl, crawlToCrawler, saveCrawl } from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../queue-jobs";
import { BullMQOtel } from "bullmq-otel";

const workerLockDuration = Number(process.env.WORKER_LOCK_DURATION) || 60000;
const workerStalledCheckInterval =
  Number(process.env.WORKER_STALLED_CHECK_INTERVAL) || 30000;
const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

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
      const { team_id, subscription_id, credits, is_extract } = job.data;
      
      logger.info(`Adding team ${team_id} billing operation to batch queue`, {
        credits,
        is_extract,
        originating_job_id: job.data.originating_job_id,
      });
      
      // Add to the REDIS batch queue 
      await queueBillingOperation(team_id, subscription_id, credits, is_extract);
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

const processPrecrawlJobInternal = async (token: string, job: Job) => {
  const logger = _logger.child({
    module: "index-worker",
    method: "processPrecrawlJobInternal",
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on precrawl job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  const teamId = process.env.PRECRAWL_TEAM_ID!;

  try {
    const budget = 100000;
    const { data, error } = await index_supabase_service.rpc("precrawl_get_top_domains", {
      i_newer_than: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
    });

    if (error) {
      logger.error("Error getting top domains", { error });
      throw error;
    }

    const total_hits = data.reduce((a, x) => a + x.count, 0);
    for (const item of data) {
      try {
        const urlObj = new URL(item.example_url);
        urlObj.pathname = "/";
        urlObj.search = "";
        urlObj.hash = "";

        const url = urlObj.toString();

        const limit = Math.round(item.count / total_hits * budget);

        logger.info("Running pre-crawl", { url, limit, hits: item.count, budget });

        const crawlerOptions = {
          ...crawlRequestSchema.parse({ url, limit }),
          url: undefined,
          scrapeOptions: undefined,
        };
        const scrapeOptions = scrapeOptionsSchema.parse({});
      
        const sc: StoredCrawl = {
          originUrl: url,
          crawlerOptions: toV0CrawlerOptions(crawlerOptions),
          scrapeOptions,
          internalOptions: {
            disableSmartWaitCache: true,
            teamId,
            saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME ? true : false,
            zeroDataRetention: true,
          }, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
          team_id: teamId,
          createdAt: Date.now(),
          maxConcurrency: undefined,
          zeroDataRetention: false,
        };

        const crawlId = uuidv4();
      
        const crawler = crawlToCrawler(crawlId, sc, null);
      
        try {
          sc.robots = await crawler.getRobotsTxt(scrapeOptions.skipTlsVerification);
          const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
          if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
            sc.crawlerOptions.delay = robotsCrawlDelay;
          }
        } catch (e) {
          logger.debug("Failed to get robots.txt (this is probably fine!)", {
            error: e,
          });
        }
      
        await saveCrawl(crawlId, sc);
      
        await _addScrapeJobToBullMQ(
          {
            url: url,
            mode: "kickoff" as const,
            team_id: teamId,
            crawlerOptions,
            scrapeOptions: sc.scrapeOptions,
            internalOptions: sc.internalOptions,
            origin: "precrawl",
            integration: null,
            crawl_id: crawlId,
            webhook: undefined,
            v1: true,
            zeroDataRetention: false,
          },
          {},
          crypto.randomUUID(),
          10,
        );
      } catch (e) {
        logger.error("Error processing one cycle of the precrawl job", { error: e });
      }
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing precrawl job", { error });
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

// Generic worker function that can process different job types
const workerFun = async (queue: Queue, jobProcessor: (token: string, job: Job) => Promise<any>) => {
  const logger = _logger.child({ module: "index-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: getRedisConnection(),
    lockDuration: workerLockDuration,
    stalledInterval: workerStalledCheckInterval,
    maxStalledCount: queue.name === precrawlQueueName ? 0 : 10,
    telemetry: new BullMQOtel("firecrawl-bullmq"),
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      logger.info("No longer accepting new jobs. SIGINT");
      break;
    }

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();

    if (!canAcceptConnection) {
      console.log("Can't accept connection due to RAM/CPU load");
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      if (cantAcceptConnectionCount >= 25) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
      }

      await new Promise((resolve) =>
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

      await new Promise((resolve) => setTimeout(resolve, gotJobInterval));
    } else {
      await new Promise((resolve) =>
        setTimeout(resolve, connectionMonitorInterval),
      );
    }
  }

  logger.info("Worker loop ended. Waiting for running jobs to finish...");
  while (runningJobs.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  logger.info("All jobs finished. Worker exiting!");
  process.exit(0);
};

const INDEX_INSERT_INTERVAL = 3000;
const WEBHOOK_INSERT_INTERVAL = 15000;
const OMCE_INSERT_INTERVAL = 5000;
const DOMAIN_FREQUENCY_INTERVAL = 10000;

// Start the workers
(async () => {
  // Start billing worker and batch processing
  startBillingBatchProcessing();
  const billingWorkerPromise = workerFun(getBillingQueue(), processBillingJobInternal);
  const precrawlWorkerPromise = process.env.PRECRAWL_TEAM_ID
    ? workerFun(getPrecrawlQueue(), processPrecrawlJobInternal)
    : (async () => { logger.warn("PRECRAWL_TEAM_ID not set, skipping precrawl worker"); })();

  const indexInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    
    await processIndexInsertJobs();
  }, INDEX_INSERT_INTERVAL);

  const webhookInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processWebhookInsertJobs();
  }, WEBHOOK_INSERT_INTERVAL);

  const indexRFInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processIndexRFInsertJobs();
  }, INDEX_INSERT_INTERVAL);

  const omceInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processOMCEJobs();
  }, OMCE_INSERT_INTERVAL);

  const domainFrequencyInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processDomainFrequencyJobs();
  }, DOMAIN_FREQUENCY_INTERVAL);

  // Wait for all workers to complete (which should only happen on shutdown)
  await Promise.all([billingWorkerPromise, precrawlWorkerPromise]);

  clearInterval(indexInserterInterval);
  clearInterval(webhookInserterInterval);
  clearInterval(indexRFInserterInterval);
  clearInterval(omceInserterInterval);
  clearInterval(domainFrequencyInterval);
})();
