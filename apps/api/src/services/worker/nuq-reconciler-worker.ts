import "dotenv/config";
import { config } from "../../config";
import { shutdownTracing } from "../../otel";
import { logger as _logger } from "../../lib/logger";
import { reconcileConcurrencyQueue } from "../../lib/concurrency-queue-reconciler";
import { repairCrawlJobDoneMarkers } from "../../lib/crawl-redis";
import { Counter, register } from "prom-client";
import Express from "express";
import { startNodeRuntimeMetrics } from "../../lib/node-runtime-metrics";
import { getPrecrawlQueue } from "../queue-service";
import { startBullmqQueueMetrics } from "../queue-metrics";
import { startRole } from "../../main";
import { runProcessStop } from "../../service/service";

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

export async function start() {
  let isShuttingDown = false;
  let reconcilerInFlight = false;

  const app = Express();
  startNodeRuntimeMetrics();
  // Exported here because this deployment runs one replica, so each queue
  // gets one series, not a copy per app pod.
  startBullmqQueueMetrics([getPrecrawlQueue()]);

  app.get("/metrics", async (_, res) => {
    try {
      res.contentType("text/plain").send(await register.metrics());
    } catch (error: unknown) {
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

  async function shutdown() {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    _logger.info("NuQ reconciler worker shutting down");

    while (reconcilerInFlight) {
      _logger.info("Waiting for in-flight reconciliation to complete...");
      await new Promise<void>(resolve => {
        setTimeout(resolve, 1000);
      });
    }

    server.close(() => {
      void (async () => {
        await runProcessStop("nuq-reconciler-worker");
        await shutdownTracing();
        _logger.info("NuQ reconciler worker shut down");
        process.exit(0);
      })();
    });
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  while (!isShuttingDown) {
    if (!reconcilerInFlight) {
      reconcilerInFlight = true;

      try {
        await repairCrawlJobDoneMarkers(_logger);
      } catch (error: unknown) {
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
      } catch (error: unknown) {
        reconcilerFailuresTotal.inc();
        _logger.error("Concurrency queue reconciler run failed", { error });
      } finally {
        reconcilerInFlight = false;
      }
    }

    await new Promise<void>(resolve => {
      setTimeout(resolve, RECONCILER_INTERVAL_MS);
    });
  }
}

if (require.main === module) {
  void startRole("nuq-reconciler-worker");
}
