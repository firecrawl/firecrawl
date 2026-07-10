import "dotenv/config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import { logger as _logger } from "../../lib/logger";
import { getCrawl } from "../../lib/crawl-redis";
import { finishCrawlSuper } from "./crawl-logic";
import {
  crawlFinishedQueueFdb,
  getNuqFdbSweeper,
  nuqFdbHealthCheck,
  nuqFdbSweeperGetMetrics,
  scrapeQueueFdb,
} from "./nuq-fdb";
import {
  isLegacyFdbWorkerLive,
  startCrawlFinishedLoop,
} from "./nuq-fdb-worker-runtime";
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
  setSentryServiceTag("nuq-fdb-worker");

  let crawlFinishedLoop: ReturnType<typeof startCrawlFinishedLoop> | null =
    null;

  await runNuqWorker({
    serviceName: "nuq-fdb-worker",
    queue: scrapeQueueFdb as any,
    healthCheck: () => nuqFdbHealthCheck(),
    livenessCheck: () => isLegacyFdbWorkerLive(crawlFinishedLoop),
    // These are process-local metrics. Queue-wide FDB ranges are deliberately
    // not scanned from every worker's Prometheus scrape callback.
    metrics: () =>
      [crawlFinishedLoop?.metrics() ?? "", nuqFdbSweeperGetMetrics()]
        .filter(Boolean)
        .join("\n"),
    beforeStart: () => {
      getNuqFdbSweeper().start();
      crawlFinishedLoop = startCrawlFinishedLoop({
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
            { module: "nuq-fdb-worker", reason },
          );
          setImmediate(() => process.exit(1));
        },
      });
    },
    onShutdownRequested: () => {
      // Stop both dequeue loops immediately, then let their in-flight jobs keep
      // renewing and drain within runNuqWorker's bounded grace period.
      crawlFinishedLoop?.stop();
      getNuqFdbSweeper().stop();
    },
    drain: async () => {
      await Promise.all([crawlFinishedLoop?.done, getNuqFdbSweeper().done]);
    },
    onShutdownDeadline: () => {
      crawlFinishedLoop?.forceStop();
      getNuqFdbSweeper().forceStop();
    },
  });
})();
