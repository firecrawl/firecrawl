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
  nuqFdbGetMetrics,
  nuqFdbHealthCheck,
  nuqFdbSweeperGetMetrics,
  scrapeQueueFdb,
} from "./nuq-fdb";
import { startCrawlFinishedLoop } from "./nuq-fdb-worker-runtime";
import { createNuqFdbWorkerOptions } from "./nuq-fdb-worker-service";
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

(async () => {
  let serviceName = "nuq-fdb-worker";
  const workerOptions = createNuqFdbWorkerOptions(config.NUQ_FDB_WORKER_MODE, {
    scrapeQueue: scrapeQueueFdb as any,
    healthCheck: nuqFdbHealthCheck,
    startMaintenance: () => {
      const sweeper = getNuqFdbSweeper();
      sweeper.start();
      return {
        name: "maintenance",
        stop: () => sweeper.stop(),
        forceStop: () => sweeper.forceStop(),
        done: sweeper.done,
        isHealthy: () => sweeper.isHealthy(),
        metrics: async () =>
          `${await nuqFdbGetMetrics()}${nuqFdbSweeperGetMetrics()}`,
      };
    },
    startCrawlFinished: () => {
      const loop = startCrawlFinishedLoop({
        queue: crawlFinishedQueueFdb as any,
        processJob: processFinishCrawlJobInternal,
        logger: _logger.child({
          module: "nuq-fdb-worker",
          method: "crawlFinishedLoop",
        }),
        onFence: reason => {
          if (reason === "shutdown") return;
          _logger.error(
            "Worker lost crawl-finished ownership; terminating stale process",
            { module: serviceName, reason },
          );
          setImmediate(() => process.exit(1));
        },
      });
      return {
        name: "crawl-finished",
        stop: () => loop.stop(),
        forceStop: () => loop.forceStop(),
        done: loop.done,
        isHealthy: () => loop.isHealthy(),
        metrics: () => loop.metrics(),
      };
    },
  });
  serviceName = workerOptions.serviceName;
  setSentryServiceTag(serviceName);
  await runNuqWorker(workerOptions);
})();
