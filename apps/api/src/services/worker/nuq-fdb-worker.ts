import "dotenv/config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { getCrawl } from "../../lib/crawl-redis";
import { finishCrawlSuper } from "./crawl-logic";
import {
  crawlFinishedQueueFdb,
  getNuqFdbSweeper,
  nuqFdbHealthCheck,
  scrapeQueueFdb,
} from "./nuq-fdb";
import { runNuqWorker } from "./nuq-worker-runner";
import type { NuQJob } from "./nuq";

async function processFinishCrawlJobInternal(_job: NuQJob) {
  const job = await crawlFinishedQueueFdb.getJob(_job.id);

  if (!job) {
    throw new Error("crawlFinish job disappeared");
  }

  if (!job.groupId) {
    throw new Error("crawlFinish job with no groupId");
  }

  if (!job.ownerId) {
    throw new Error("crawlFinish job with no ownerId");
  }

  const sc = await getCrawl(job.groupId);

  if (!sc) {
    throw new Error("crawlFinish job with sc expired");
  }

  const anyJob = await scrapeQueueFdb.getGroupAnyJob(job.groupId, job.ownerId);

  if (!anyJob) {
    throw new Error("crawlFinish couldn't find anyJob");
  }

  await finishCrawlSuper(anyJob as any);
}

function startCrawlFinishedLoop() {
  let shuttingDown = false;

  const loop = (async () => {
    let noJobTimeout = 1500;

    while (!shuttingDown) {
      const job = await crawlFinishedQueueFdb.getJobToProcess();

      if (job === null) {
        await new Promise(resolve => setTimeout(resolve, noJobTimeout));
        if (!config.NUQ_RABBITMQ_URL) {
          noJobTimeout = Math.min(noJobTimeout * 2, 10000);
        }
        continue;
      }

      noJobTimeout = 500;

      const logger = _logger.child({
        module: "nuq-fdb-worker",
        method: "crawlFinishedLoop",
        jobId: job.id,
        crawlId: job.groupId,
      });

      logger.info("Acquired crawl finished job");

      const lockRenewInterval = setInterval(async () => {
        try {
          logger.info("Renewing crawl finished lock");
          if (
            !(await crawlFinishedQueueFdb.renewLock(job.id, job.lock!, logger))
          ) {
            logger.warn("Failed to renew crawl finished lock");
            clearInterval(lockRenewInterval);
          }
        } catch (error) {
          logger.warn("Failed to renew crawl finished lock", { error });
          clearInterval(lockRenewInterval);
        }
      }, 15000);

      try {
        await processFinishCrawlJobInternal(job as any);
        if (
          !(await crawlFinishedQueueFdb.jobFinish(
            job.id,
            job.lock!,
            null,
            logger,
          ))
        ) {
          logger.warn("Could not update crawl finished job status");
        }
      } catch (error) {
        logger.error("Crawl finished job failed", { error });
        if (
          !(await crawlFinishedQueueFdb.jobFail(
            job.id,
            job.lock!,
            error instanceof Error ? error.message : JSON.stringify(error),
            logger,
          ))
        ) {
          logger.warn("Could not update crawl finished job status");
        }
      } finally {
        clearInterval(lockRenewInterval);
      }
    }
  })();

  const done = loop.catch(error => {
    _logger.error("Crawl finished loop stopped unexpectedly", {
      module: "nuq-fdb-worker",
      error,
    });
  });

  return {
    stop() {
      shuttingDown = true;
    },
    done,
  };
}

(async () => {
  setSentryServiceTag("nuq-fdb-worker");

  let crawlFinishedLoop: ReturnType<typeof startCrawlFinishedLoop> | null =
    null;

  await runNuqWorker({
    serviceName: "nuq-fdb-worker",
    queue: scrapeQueueFdb as any,
    healthCheck: () => nuqFdbHealthCheck(),
    beforeStart: () => {
      getNuqFdbSweeper().start();
      crawlFinishedLoop = startCrawlFinishedLoop();
    },
    beforeShutdown: async () => {
      crawlFinishedLoop?.stop();
      try {
        await crawlFinishedLoop?.done;
      } finally {
        getNuqFdbSweeper().stop();
      }
    },
  });
})();
