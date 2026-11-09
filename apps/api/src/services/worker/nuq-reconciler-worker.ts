import "dotenv/config";
import { config } from "../../config";
import { shutdownTracing } from "../../otel";
import { logger as _logger } from "../../lib/logger";
import { reconcileConcurrencyQueue } from "../../lib/concurrency-queue-reconciler";
import { repairCrawlJobDoneMarkers } from "../../lib/crawl-redis";
import { Counter, register } from "prom-client";
import Express from "express";
import { startNodeRuntimeMetrics } from "../../lib/node-runtime-metrics";
import { Worker } from "bullmq";
import {
  getFirebillTrackRetryQueue,
  getRedisConnection,
} from "../queue-service";
import {
  firebillConfigured,
  processFirebillTrackRetry,
} from "../autumn/firebill";

const RECONCILER_INTERVAL_MS = 60 * 1000;

const reconcilerRunsTotal = new Counter({
  name: "concurrency_queue_reconciler_runs_total",
  help: "Total completed concurrency queue reconciler runs",
});

const reconcilerFailuresTotal = new Counter({
  name: "concurrency_queue_reconciler_failures_total",
  help: "Total failed concurrency queue reconciler runs",
});

const reconcilerJobsRecoveredTotal = new Counter({
  name: "concurrency_queue_reconciler_jobs_recovered_total",
  help: "Total drifted jobs recovered by the reconciler",
});

(async () => {
  let isShuttingDown = false;
  let reconcilerInFlight = false;

  const app = Express();
  startNodeRuntimeMetrics();

  app.get("/metrics", async (_, res) => {
    try {
      res.contentType("text/plain").send(await register.metrics());
    } catch (error) {
      _logger.error("Failed to collect metrics", { error });
      res.status(500).send("Failed to collect metrics");
    }
  });
  app.get("/health", (_, res) => {
    res.status(200).send("OK");
  });

  const server = app.listen(
    config.NUQ_RECONCILER_WORKER_PORT,
    (error?: Error) => {
      if (error) {
        _logger.error("Failed to start NuQ reconciler worker", {
          error,
          port: config.NUQ_RECONCILER_WORKER_PORT,
        });
        throw error;
      }

      _logger.info("NuQ reconciler worker started", {
        port: config.NUQ_RECONCILER_WORKER_PORT,
      });
    },
  );

  // Re-sends usage events firebill never confirmed. Jobs live in Redis, so
  // one consumer is enough: if this pod goes, its delayed retries wait for
  // the next one rather than being lost.
  const firebillTrackRetryWorker = firebillConfigured()
    ? new Worker(getFirebillTrackRetryQueue().name, processFirebillTrackRetry, {
        connection: getRedisConnection(),
        concurrency: 16,
        maxStalledCount: 10,
      })
    : undefined;
  firebillTrackRetryWorker?.on("error", error => {
    _logger.error("firebill track retry worker error", { error });
  });

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    _logger.info("NuQ reconciler worker shutting down");

    await firebillTrackRetryWorker?.close();

    while (reconcilerInFlight) {
      _logger.info("Waiting for in-flight reconciliation to complete...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    server.close(async () => {
      await shutdownTracing();
      _logger.info("NuQ reconciler worker shut down");
      process.exit(0);
    });
  }

  if (require.main === module) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  while (!isShuttingDown) {
    if (!reconcilerInFlight) {
      reconcilerInFlight = true;

      try {
        await repairCrawlJobDoneMarkers(_logger);
      } catch (error) {
        _logger.error("Crawl completion marker repair run failed", { error });
      }

      try {
        const summary = await reconcileConcurrencyQueue({
          logger: _logger,
        });

        reconcilerRunsTotal.inc();
        reconcilerJobsRecoveredTotal.inc(
          summary.jobsRequeued + summary.jobsStarted,
        );

        _logger.info("Concurrency queue reconciler run complete", summary);
      } catch (error) {
        reconcilerFailuresTotal.inc();
        _logger.error("Concurrency queue reconciler run failed", { error });
      } finally {
        reconcilerInFlight = false;
      }
    }

    await new Promise(resolve => setTimeout(resolve, RECONCILER_INTERVAL_MS));
  }
})();
