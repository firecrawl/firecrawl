import "dotenv/config";
import "./sentry";
import * as Sentry from "@sentry/node";
import {
  getScrapeQueue,
  getExtractQueue,
  getDeepResearchQueue,
  getGenerateLlmsTxtQueue,
  scrapeQueueName,
  getRedisConnection,
} from "./queue-service";
import { Job, Queue, QueueEvents } from "bullmq";
import { logger as _logger } from "../lib/logger";
import { Worker } from "bullmq";
import systemMonitor from "./system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  addCrawlJobDone,
  finishCrawlKickoff,
  getCrawl,
  normalizeURL,
} from "../lib/crawl-redis";
import { StoredCrawl } from "../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { concurrentJobDone } from "../lib/concurrency-limit";
import {
  ExtractResult,
  performExtraction,
} from "../lib/extract/extraction-service";
import { updateExtract } from "../lib/extract/extract-redis";
import { updateDeepResearch } from "../lib/deep-research/deep-research-redis";
import { performDeepResearch } from "../lib/deep-research/deep-research-service";
import { performGenerateLlmsTxt } from "../lib/generate-llmstxt/generate-llmstxt-service";
import { updateGeneratedLlmsTxt } from "../lib/generate-llmstxt/generate-llmstxt-redis";
import { performExtraction_F0 } from "../lib/extract/fire-0/extraction-service-f0";
import Express from "express";
import http from "http";
import https from "https";
import { cacheableLookup } from "../scraper/scrapeURL/lib/cacheableLookup";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { redisEvictConnection } from "./redis";
import path from "path";
import { finishCrawlIfNeeded } from "./worker/crawl-logic";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { LangfuseExporter } from "langfuse-vercel";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { BullMQOtel } from "bullmq-otel";
import { pathToFileURL } from "url";

configDotenv();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Install cacheable lookup for all other requests
cacheableLookup.install(http.globalAgent);
cacheableLookup.install(https.globalAgent);

const shouldOtel = process.env.LANGFUSE_PUBLIC_KEY || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otelSdk = shouldOtel ? new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "firecrawl-worker",
  }),
  spanProcessors: [
    ...(process.env.LANGFUSE_PUBLIC_KEY ? [new BatchSpanProcessor(new LangfuseExporter())] : []),
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? [new BatchSpanProcessor(new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    }))] : []),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
}) : null;

if (otelSdk) {
  otelSdk.start();
}

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

  try {
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
      });
    } else {
      result = await performExtraction_F0(job.data.extractId, {
        request: job.data.request,
        teamId: job.data.teamId,
        subId: job.data.subId,
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
      return result;
    } else {
      // throw new Error(result.error || "Unknown error during extraction");

      await job.moveToCompleted(result, token, false);
      await updateExtract(job.data.extractId, {
        status: "failed",
        error:
          result?.error ??
          "Unknown error, please contact help@firecrawl.com. Extract id: " +
            job.data.extractId,
      });

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
      error:
        error.error ??
        error ??
        "Unknown error, please contact help@firecrawl.com. Extract id: " +
          job.data.extractId,
    });
    return {
      success: false,
      error:
        error.error ??
        error ??
        "Unknown error, please contact help@firecrawl.com. Extract id: " +
          job.data.extractId,
    };
    // throw error;
  } finally {
    clearInterval(extendLockInterval);
  }
};

const processDeepResearchJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "deep-research-worker",
    method: "processJobInternal",
    jobId: job.id,
    researchId: job.data.researchId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  try {
    console.log(
      "[Deep Research] Starting deep research: ",
      job.data.researchId,
    );
    const result = await performDeepResearch({
      researchId: job.data.researchId,
      teamId: job.data.teamId,
      query: job.data.request.query,
      maxDepth: job.data.request.maxDepth,
      timeLimit: job.data.request.timeLimit,
      subId: job.data.subId,
      maxUrls: job.data.request.maxUrls,
      analysisPrompt: job.data.request.analysisPrompt,
      systemPrompt: job.data.request.systemPrompt,
      formats: job.data.request.formats,
      jsonOptions: job.data.request.jsonOptions,
    });

    if (result.success) {
      // Move job to completed state in Redis and update research status
      await job.moveToCompleted(result, token, false);
      return result;
    } else {
      // If the deep research failed but didn't throw an error
      const error = new Error("Deep research failed without specific error");
      await updateDeepResearch(job.data.researchId, {
        status: "failed",
        error: error.message,
      });
      await job.moveToFailed(error, token, false);

      return { success: false, error: error.message };
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
      logger.error("Failed to move job to failed state in Redis", { error });
    }

    await updateDeepResearch(job.data.researchId, {
      status: "failed",
      error: error.message || "Unknown error occurred",
    });

    return { success: false, error: error.message || "Unknown error occurred" };
  } finally {
    clearInterval(extendLockInterval);
  }
};

const processGenerateLlmsTxtJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "generate-llmstxt-worker",
    method: "processJobInternal",
    jobId: job.id,
    generateId: job.data.generateId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  try {
    const result = await performGenerateLlmsTxt({
      generationId: job.data.generationId,
      teamId: job.data.teamId,
      url: job.data.request.url,
      maxUrls: job.data.request.maxUrls,
      showFullText: job.data.request.showFullText,
      subId: job.data.subId,
      cache: job.data.request.cache,
    });

    if (result.success) {
      await job.moveToCompleted(result, token, false);
      await updateGeneratedLlmsTxt(job.data.generateId, {
        status: "completed",
        generatedText: result.data.generatedText,
        fullText: result.data.fullText,
      });
      return result;
    } else {
      const error = new Error(
        "LLMs text generation failed without specific error",
      );
      await job.moveToFailed(error, token, false);
      await updateGeneratedLlmsTxt(job.data.generateId, {
        status: "failed",
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  } catch (error) {
    logger.error(`🚫 Job errored ${job.id} - ${error}`, { error });

    Sentry.captureException(error, {
      data: {
        job: job.id,
      },
    });

    try {
      await job.moveToFailed(error, token, false);
    } catch (e) {
      logger.error("Failed to move job to failed state in Redis", { error });
    }

    await updateGeneratedLlmsTxt(job.data.generateId, {
      status: "failed",
      error: error.message || "Unknown error occurred",
    });

    return { success: false, error: error.message || "Unknown error occurred" };
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;
let isWorkerStalled = false;

process.on("SIGINT", () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

/**
 * Converts a file path to a proper URL for cross-platform compatibility.
 * On Windows, absolute paths need to be converted to file:// URLs for ESM imports.
 * @param filePath - The file path to convert
 * @returns A properly formatted path/URL for the current platform
 */
function getWorkerPath(filePath: string): string | URL {
  if (process.platform === 'win32' && path.isAbsolute(filePath)) {
    // On Windows, convert absolute paths to file:// URLs for ESM compatibility
    return pathToFileURL(filePath);
  }
  return filePath;
}

const separateWorkerFun = (
  queue: Queue,
  workerPath: string,
): Worker => {
  // Extract memory size from --max-old-space-size flag if present
  const maxOldSpaceSize = process.env.SCRAPE_WORKER_MAX_OLD_SPACE_SIZE || process.execArgv
    .find(arg => arg.startsWith('--max-old-space-size='))
    ?.split('=')[1];

  // Filter out the invalid flag for worker threads
  const filteredExecArgv = process.execArgv
    .filter(arg => !arg.startsWith('--max-old-space-size'));

  // Convert path to proper format for the current platform
  const platformWorkerPath = getWorkerPath(workerPath);

  const worker = new Worker(queue.name, platformWorkerPath, {
    connection: getRedisConnection(),
    lockDuration: 60 * 1000, // 60 seconds
    stalledInterval: 60 * 1000, // 60 seconds
    maxStalledCount: 10, // 10 times
    concurrency: 8,
    useWorkerThreads: false,
    workerForkOptions: {
      execArgv: filteredExecArgv.concat(maxOldSpaceSize ? (
        ['--max-old-space-size=' + maxOldSpaceSize]
      ) : []),
    },
    workerThreadsOptions: {
      execArgv: filteredExecArgv,
      resourceLimits: maxOldSpaceSize ? {
        maxOldGenerationSizeMb: parseInt(maxOldSpaceSize)
      } : undefined
    },
    telemetry: new BullMQOtel("firecrawl-bullmq"),
  });

  return worker;
};

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
      console.log("No longer accepting new jobs. SIGINT");
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

      async function afterJobDone(job: Job<any, any, string>) {
        try {
          await concurrentJobDone(job);
        } finally {
          if (job.id) {
            runningJobs.delete(job.id);
          }
        }
      }

      processJobInternal(token, job).finally(() => afterJobDone(job));

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
      }).catch(e => {
        _logger.error("WORKER NETWORKING CHECK FAILED", { error: e });
        currentLiveness = false;
        res.status(500).json({ ok: false });
      });
  } else {
    currentLiveness = true;
    res.status(200).json({ ok: true });
  }
});

const workerPort = process.env.WORKER_PORT || process.env.PORT || 3005;
app.listen(workerPort, () => {
  _logger.info(`Liveness endpoint is running on port ${workerPort}`);
});

(async () => {
  async function failedListener(args: { jobId: string; failedReason: string; prev?: string | undefined; }) {
    const job = await getScrapeQueue().getJob(args.jobId);

    if (job && job.data.crawl_id) {
      await redisEvictConnection.srem("crawl:" + job.data.crawl_id + ":jobs_qualified", args.jobId);
      await redisEvictConnection.expire("crawl:" + job.data.crawl_id + ":jobs_qualified", 24 * 60 * 60);
    }

    if (args.failedReason === "job stalled more than allowable limit") {
      const set = await redisEvictConnection.set(
        "stalled-job-cleaner:" + args.jobId,
        "1",
        "EX",
        60 * 60 * 24,
        "NX",
      );
      if (!set) {
        return;
      }

      let logger = _logger.child({ jobId: args.jobId, scrapeId: args.jobId, module: "queue-worker", method: "failedListener", zeroDataRetention: job?.data.zeroDataRetention });
      if (job && job.data.crawl_id) {
        logger = logger.child({ crawlId: job.data.crawl_id });
        logger.warn("Job stalled more than allowable limit");

        const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

        if (job.data.mode === "kickoff") {
          await finishCrawlKickoff(job.data.crawl_id);
          if (sc) {
            await finishCrawlIfNeeded(job, sc);
          }
        } else {
          const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

          logger.debug("Declaring job as done...");
          await addCrawlJobDone(job.data.crawl_id, job.id, false, logger);
          await redisEvictConnection.srem(
            "crawl:" + job.data.crawl_id + ":visited_unique",
            normalizeURL(job.data.url, sc),
          );

          await finishCrawlIfNeeded(job, sc);
        }
      } else {
        logger.warn("Job stalled more than allowable limit");
      }
    }
  }

  const scrapeQueueEvents = new QueueEvents(scrapeQueueName, { connection: getRedisConnection() });
  scrapeQueueEvents.on("failed", failedListener);

  const results = await Promise.all([
    separateWorkerFun(
      getScrapeQueue(),
      path.join(__dirname, "worker", "scrape-worker.js"),
    ),
    workerFun(getExtractQueue(), processExtractJobInternal),
    workerFun(getDeepResearchQueue(), processDeepResearchJobInternal),
    workerFun(getGenerateLlmsTxtQueue(), processGenerateLlmsTxtJobInternal),
  ]);

  console.log("All workers exited. Waiting for all jobs to finish...");

  const workerResults = results.filter((x) => x instanceof Worker);
  await Promise.all(workerResults.map((x) => x.close()));

  while (runningJobs.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  setInterval(async () => {
    _logger.debug("Currently running jobs", {
      jobs: (
        await Promise.all(
          [...runningJobs].map(async (jobId) => {
            return await getScrapeQueue().getJob(jobId);
          }),
        )
      ).filter((x) => x && !x.data?.zeroDataRetention),
    });
  }, 1000);

  await scrapeQueueEvents.close();
  console.log("All jobs finished. Worker out!");
  if (otelSdk) {
    await otelSdk.shutdown();
  }
  process.exit(0);
})();
