import "dotenv/config";
import { config } from "../config";
import { shutdownTracing } from "../otel";
import { logger as _logger } from "../lib/logger";
import { configDotenv } from "dotenv";
import Express from "express";
import { register } from "prom-client";
import { robustFetch } from "../scraper/scrapeURL/lib/fetch";
import { service } from "../service";
import { initializeEngineForcing } from "../scraper/WebScraper/utils/engine-forcing";
import { crawlFinishedQueue, NuQJob, scrapeQueue } from "./worker/nuq";
import { finishCrawlSuper } from "./worker/crawl-logic";
import { getCrawl } from "../lib/crawl-redis";
import { recordCrawlStateMissing } from "../lib/crawl-state-metrics";
import { startRole } from "../main";
import { runProcessStop } from "../service/service";

configDotenv();

async function processFinishCrawlJobInternal(_job: NuQJob) {
  const job = await crawlFinishedQueue.getJob(_job.id);

  if (!job) {
    throw new Error("crawlFinish job disappeared");
  }

  if (!job.groupId) {
    throw new Error("crawlFinish job with no groupId");
  }

  if (!job.ownerId) {
    throw new Error("crawlFinish job with no ownerId");
  }

  const anyJob = await scrapeQueue.getGroupAnyJob(job.groupId, job.ownerId);

  if (!anyJob) {
    if (!(await getCrawl(job.groupId))) {
      recordCrawlStateMissing("finalizer", job.groupId, _logger, {
        jobId: job.id,
        recoverable: false,
      });
    }
    throw new Error("crawlFinish couldn't find anyJob");
  }

  await finishCrawlSuper(anyJob);
}

let isShuttingDown = false;

const crawlFinishWorker = async () => {
  const __logger = _logger.child({
    module: "extract-worker",
    method: "crawlFinishWorker",
  });

  let noJobTimeout = 1500;

  while (!isShuttingDown) {
    const job = await crawlFinishedQueue.getJobToProcess();

    if (job === null) {
      __logger.info("No jobs to process", { module: "nuq/metrics" });
      await new Promise(resolve => setTimeout(resolve, noJobTimeout));
      if (!config.NUQ_RABBITMQ_URL) {
        noJobTimeout = Math.min(noJobTimeout * 2, 10000);
      }
      continue;
    }

    noJobTimeout = 500;

    const logger = __logger.child({
      zeroDataRetention: job.data?.zeroDataRetention ?? false,
      crawlId: job.groupId,
    });

    logger.info("Acquired job");

    const lockRenewInterval = setInterval(async () => {
      logger.info("Renewing lock");
      if (!(await crawlFinishedQueue.renewLock(job.id, job.lock!, logger))) {
        logger.warn("Failed to renew lock");
        clearInterval(lockRenewInterval);
        return;
      }
      logger.info("Renewed lock");
    }, 15000);

    let processResult:
      | {
          ok: true;
          data: Awaited<ReturnType<typeof processFinishCrawlJobInternal>>;
        }
      | { ok: false; error: any };

    try {
      processResult = {
        ok: true,
        data: await processFinishCrawlJobInternal(job),
      };
    } catch (error) {
      processResult = { ok: false, error };
    }

    clearInterval(lockRenewInterval);

    if (processResult.ok) {
      if (
        !(await crawlFinishedQueue.jobFinish(
          job.id,
          job.lock!,
          processResult.data,
          logger,
        ))
      ) {
        logger.warn("Could not update job status");
      }
    } else {
      if (
        !(await crawlFinishedQueue.jobFail(
          job.id,
          job.lock!,
          processResult.error instanceof Error
            ? processResult.error.message
            : typeof processResult.error === "string"
              ? processResult.error
              : JSON.stringify(processResult.error),
          logger,
        ))
      ) {
        logger.warn("Could not update job status");
      }
    }
  }
};

const app = Express();

let currentLiveness: boolean = true;

app.get("/metrics", async (_, res) => {
  res.contentType("text/plain").send(await register.metrics());
});

app.get("/liveness", (req, res) => {
  _logger.info("Liveness endpoint hit");
  if (config.IS_KUBERNETES && config.NUQ_RABBITMQ_URL) {
    // networking check for Kubernetes environments
    const host = config.FIRECRAWL_APP_HOST;
    const port = config.FIRECRAWL_APP_PORT;
    const scheme = config.FIRECRAWL_APP_SCHEME;

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

const workerPort = config.WORKER_PORT || config.PORT;
app.listen(workerPort, (error?: Error) => {
  if (error) {
    _logger.error("Failed to start liveness endpoint", {
      error,
      port: workerPort,
    });
    throw error;
  }

  _logger.info(`Liveness endpoint is running on port ${workerPort}`);
});

export async function start() {
  process.on("SIGINT", () => {
    _logger.debug("Received SIGINT. Shutting down gracefully...");
    isShuttingDown = true;
  });

  process.on("SIGTERM", () => {
    _logger.debug("Received SIGTERM. Shutting down gracefully...");
    isShuttingDown = true;
  });

  await service.modules.blocklist.init().catch(e => {
    _logger.error("Failed to initialize blocklist", { error: e });
    process.exit(1);
  });

  initializeEngineForcing();

  await crawlFinishWorker();

  _logger.info("All jobs finished. Shutting down...");
  await runProcessStop("queue-worker");
  await shutdownTracing();
  process.exit(0);
}

if (require.main === module) {
  void startRole("queue-worker");
}
