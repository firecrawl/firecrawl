import "dotenv/config";
import { config } from "../../config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import { logger as _logger } from "../../lib/logger";
import { reconcileConcurrencyQueue } from "../../lib/concurrency-queue-reconciler";
import { Counter, Gauge, Histogram, register } from "prom-client";
import Express from "express";

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

const migrationGcRunsTotal = new Counter({
  name: "nuq_migration_gc_runs_total",
  help: "NuQ migration GC category runs",
  labelNames: ["category"] as const,
});
const migrationGcPagesTotal = new Counter({
  name: "nuq_migration_gc_pages_total",
  help: "Bounded NuQ migration GC pages processed",
  labelNames: ["category"] as const,
});
const migrationGcItemsTotal = new Counter({
  name: "nuq_migration_gc_items_total",
  help: "NuQ migration GC items by outcome",
  labelNames: ["category", "outcome"] as const,
});
const migrationGcErrorsTotal = new Counter({
  name: "nuq_migration_gc_errors_total",
  help: "NuQ migration GC category errors",
  labelNames: ["category"] as const,
});
const migrationGcDueBacklog = new Gauge({
  name: "nuq_migration_gc_due_backlog",
  help: "Exact number of due NuQ migration GC items",
  labelNames: ["category"] as const,
});
const migrationGcOldestOverdueSeconds = new Gauge({
  name: "nuq_migration_gc_oldest_overdue_seconds",
  help: "Age in seconds of the oldest due NuQ migration GC item",
  labelNames: ["category"] as const,
});
const migrationGcRunDurationSeconds = new Histogram({
  name: "nuq_migration_gc_run_duration_seconds",
  help: "Duration of each bounded migration GC run",
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60],
});
const migrationGcProcessedRate = new Gauge({
  name: "nuq_migration_gc_processed_items_per_second",
  help: "Observed item processing rate during the latest GC run",
  labelNames: ["category"] as const,
});

(async () => {
  setSentryServiceTag("nuq-reconciler-worker");

  let isShuttingDown = false;
  let reconcilerInFlight = false;
  const shutdownController = new AbortController();

  const app = Express();

  app.get("/metrics", async (_, res) => {
    try {
      res.contentType("text/plain").send(await register.metrics());
    } catch (error) {
      _logger.error("Failed to collect metrics", { error });
      res.status(500).send("Failed to collect metrics");
    }
  });
  app.get("/health", (_, res) => {
    res
      .status(isShuttingDown ? 503 : 200)
      .send(isShuttingDown ? "STOPPING" : "OK");
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
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownController.abort();
    _logger.info("NuQ reconciler worker shutting down");
    server.close();

    const graceMs = 15_000;
    const deadline = Date.now() + graceMs;
    while (reconcilerInFlight && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (reconcilerInFlight) {
      _logger.error("Reconciler did not stop within shutdown grace", {
        graceMs,
      });
      server.closeAllConnections();
      process.exit(1);
    }
    _logger.info("NuQ reconciler worker shut down");
    process.exit(0);
  }

  if (require.main === module) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  const sleep = async (ms: number) => {
    if (shutdownController.signal.aborted) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      shutdownController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  };

  while (!isShuttingDown) {
    let nextIntervalMs = config.NUQ_RECONCILER_IDLE_INTERVAL_MS;
    if (!reconcilerInFlight) {
      reconcilerInFlight = true;

      try {
        const summary = await reconcileConcurrencyQueue({
          logger: _logger,
          signal: shutdownController.signal,
        });

        reconcilerRunsTotal.inc();
        reconcilerJobsRecoveredTotal.inc(
          summary.jobsRequeued + summary.jobsStarted,
        );
        nextIntervalMs = summary.migrationGc.hasMore
          ? config.NUQ_RECONCILER_BACKLOG_RETRY_MS
          : config.NUQ_RECONCILER_IDLE_INTERVAL_MS;
        migrationGcRunDurationSeconds.observe(
          summary.migrationGc.elapsedMs / 1000,
        );
        for (const [category, stats] of Object.entries(
          summary.migrationGc.categories,
        )) {
          migrationGcRunsTotal.inc({ category });
          migrationGcPagesTotal.inc({ category }, stats.pages);
          migrationGcItemsTotal.inc(
            { category, outcome: "processed" },
            stats.processed,
          );
          migrationGcItemsTotal.inc(
            { category, outcome: "removed" },
            stats.removed,
          );
          migrationGcItemsTotal.inc(
            { category, outcome: "retained" },
            stats.retained,
          );
          migrationGcItemsTotal.inc(
            { category, outcome: "stale" },
            stats.stale,
          );
          migrationGcErrorsTotal.inc({ category }, stats.errors);
          migrationGcDueBacklog.set({ category }, stats.dueBacklog);
          migrationGcOldestOverdueSeconds.set(
            { category },
            stats.oldestOverdueMs / 1000,
          );
          migrationGcProcessedRate.set(
            { category },
            summary.migrationGc.elapsedMs > 0
              ? (stats.processed * 1000) / summary.migrationGc.elapsedMs
              : 0,
          );
        }

        _logger.info("Concurrency queue reconciler run complete", summary);
      } catch (error) {
        reconcilerFailuresTotal.inc();
        _logger.error("Concurrency queue reconciler run failed", { error });
      } finally {
        reconcilerInFlight = false;
      }
    }

    await sleep(nextIntervalMs);
  }
})();
