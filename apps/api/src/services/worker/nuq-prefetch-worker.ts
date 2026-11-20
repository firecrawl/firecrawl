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
  installWorkerLifecycle,
  retryDependency,
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

  async function shutdown() {
    server.close();
    await nuqShutdown();
    await shutdownTracing();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  installWorkerLifecycle("nuq-prefetch-worker");

  await Promise.all([
    (async () => {
      while (true) {
        // A prefetch pass against an unreachable database is worth retrying,
        // not worth losing the process over: the queue fills back up once the
        // dependency returns.
        const prefetch = await retryDependency(() =>
          crawlFinishedQueue.prefetchJobs(),
        );
        if (prefetch === null) {
          logger.error("crawlFinished prefetch failed after retrying", {
            module: "nuq-prefetch-worker",
          });
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })(),
    (async () => {
      while (true) {
        if (config.NUQ_PREFETCH_WORKER_HEARTBEAT_URL) {
          fetch(config.NUQ_PREFETCH_WORKER_HEARTBEAT_URL).catch(() => {});
        }
        const prefetch = await retryDependency(() =>
          scrapeQueue.prefetchJobs(),
        );
        if (prefetch === null) {
          logger.error("NuQ prefetch failed after retrying", {
            module: "nuq-prefetch-worker",
          });
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })(),
  ]);

  logger.info("All prefetch workers exited. Shutting down...");
  await shutdown();
}

if (require.main === module) {
  void startRole("nuq-prefetch-worker");
}
