import "dotenv/config";
import { config } from "../../config";
import { shutdownTracing } from "../../otel";
import {
  scrapeQueue,
  nuqGetLocalMetrics,
  nuqHealthCheck,
  nuqShutdown,
  crawlFinishedQueue,
} from "./nuq";
import Express from "express";
import { logger } from "../../lib/logger";
import {
  DEPENDENCY_BACKOFF_MS,
  installWorkerLifecycle,
} from "../../lib/worker-lifecycle";
import { startRole } from "../../main";

export async function start() {
  const app = Express();

  app.get("/metrics", (_, res) =>
    res.contentType("text/plain").send(nuqGetLocalMetrics()),
  );
  app.get("/health", async (_, res) => {
    if (await nuqHealthCheck()) {
      res.status(200).send("OK");
    } else {
      res.status(500).send("Not OK");
    }
  });

  const server = app.listen(
    config.NUQ_PREFETCH_WORKER_PORT,
    (error?: Error) => {
      if (error) {
        logger.error("Failed to start NuQ prefetch worker metrics server", {
          error,
          port: config.NUQ_PREFETCH_WORKER_PORT,
        });
        throw error;
      }

      logger.info("NuQ prefetch worker metrics server started");
    },
  );

  const shutdownController = new AbortController();

  async function shutdown() {
    shutdownController.abort();
    server.close();
    await nuqShutdown();
    await shutdownTracing();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  installWorkerLifecycle("nuq-prefetch-worker");

  // A prefetch pass claims a batch before publishing it, so a failed pass must
  // not be retried in place: the retry would claim a second batch while the
  // first still holds its locks. Back off the loop instead and let the lock
  // reaper release the stranded batch, as it already does today.
  async function prefetchPass(
    serviceName: string,
    prefetch: () => Promise<number>,
  ) {
    try {
      return await prefetch();
    } catch (error) {
      logger.error("Prefetch pass failed; backing off", {
        module: "nuq-prefetch-worker",
        serviceName,
        error,
      });
      return null;
    }
  }

  // Bounded by DEPENDENCY_BACKOFF_MS: the loop keeps going, but a dependency
  // that rejects a prefetch pass is not hammered with a new claim every 250ms.
  function backoffMs(failuresInARow: number): number {
    return DEPENDENCY_BACKOFF_MS[
      Math.min(failuresInARow, DEPENDENCY_BACKOFF_MS.length) - 1
    ];
  }

  await Promise.all([
    (async () => {
      let failuresInARow = 0;
      while (true) {
        const prefetched = await prefetchPass("crawlFinished", () =>
          crawlFinishedQueue.prefetchJobs(),
        );
        failuresInARow = prefetched === null ? failuresInARow + 1 : 0;
        await new Promise(resolve =>
          setTimeout(resolve, failuresInARow ? backoffMs(failuresInARow) : 250),
        );
      }
    })(),
    (async () => {
      let failuresInARow = 0;
      while (true) {
        const prefetched = await prefetchPass("nuq", () =>
          scrapeQueue.prefetchJobs(),
        );
        failuresInARow = prefetched === null ? failuresInARow + 1 : 0;

        // Only report live once a pass has actually gone through: a heartbeat
        // sent while prefetching fails would tell the monitor the worker is
        // healthy during a dependency outage.
        if (prefetched !== null && config.NUQ_PREFETCH_WORKER_HEARTBEAT_URL) {
          fetch(config.NUQ_PREFETCH_WORKER_HEARTBEAT_URL).catch(() => {});
        }

        await new Promise(resolve =>
          setTimeout(resolve, failuresInARow ? backoffMs(failuresInARow) : 250),
        );
      }
    })(),
  ]);

  logger.info("All prefetch workers exited. Shutting down...");
  await shutdown();
}

if (require.main === module) {
  void startRole("nuq-prefetch-worker");
}
