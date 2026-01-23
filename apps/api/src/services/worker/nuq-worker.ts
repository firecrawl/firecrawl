import "dotenv/config";
import { config } from "../../config";
import "../sentry";
import { setSentryServiceTag } from "../sentry";
import { logger as _logger } from "../../lib/logger";
import { processJobInternal } from "./scrape-worker";
import { scrapeQueue, nuqGetLocalMetrics, nuqHealthCheck } from "./nuq";
import Express from "express";
import { _ } from "ajv";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";

(async () => {
  setSentryServiceTag("nuq-worker");

  try {
    await initializeBlocklist();
    initializeEngineForcing();
  } catch (error) {
    _logger.error("Failed to initialize blocklist and engine forcing", {
      error,
    });
    process.exit(1);
  }

  let isShuttingDown = false;

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

  const server = app.listen(config.NUQ_WORKER_PORT, () => {
    _logger.info("NuQ worker metrics server started");
  });

  function shutdown() {
    isShuttingDown = true;
  }

  if (require.main === module) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  let noJobTimeout = 1500;

  while (!isShuttingDown) {
    const job = await scrapeQueue.getJobToProcess();

    if (job === null) {
      _logger.info("No jobs to process", { module: "nuq/metrics" });
      await new Promise(resolve => setTimeout(resolve, noJobTimeout));
      if (!config.NUQ_RABBITMQ_URL) {
        noJobTimeout = Math.min(noJobTimeout * 2, 10000);
      }
      continue;
    }

    noJobTimeout = 500;

    const jobStartTime = Date.now();
    const jobMode = job.data?.mode ?? "unknown";
    const crawlId = job.data?.crawl_id ?? undefined;
    const jobUrl = job.data?.mode === "single_urls" ? job.data?.url :
                   job.data?.mode === "kickoff_sitemap" ? job.data?.sitemapUrl :
                   job.data?.mode === "kickoff" ? job.data?.url : undefined;

    const logger = _logger.child({
      module: "nuq-worker",
      scrapeId: job.id,
      crawlId,
      mode: jobMode,
      zeroDataRetention: job.data?.zeroDataRetention ?? false,
    });

    logger.info("Acquired job", {
      mode: jobMode,
      crawlId,
      url: jobUrl,
    });

    let renewalCount = 0;
    const lockRenewInterval = setInterval(async () => {
      renewalCount++;
      const elapsedMs = Date.now() - jobStartTime;
      const elapsedSeconds = Math.round(elapsedMs / 1000);

      // Determine stale warning level based on elapsed time
      let staleWarning: string | null = null;
      if (elapsedMs >= 300000) staleWarning = "CRITICAL";
      else if (elapsedMs >= 120000) staleWarning = "HIGH";
      else if (elapsedMs >= 60000) staleWarning = "MEDIUM";
      else if (elapsedMs >= 30000) staleWarning = "LOW";

      const logData = {
        renewalCount,
        elapsedSeconds,
        elapsedMs,
        ...(staleWarning ? { staleWarning } : {}),
      };

      if (staleWarning) {
        logger.warn("Renewing lock - job running long", logData);
      } else {
        logger.info("Renewing lock", logData);
      }

      if (!(await scrapeQueue.renewLock(job.id, job.lock!, logger))) {
        logger.warn("Failed to renew lock", logData);
        clearInterval(lockRenewInterval);
        return;
      }
      logger.debug("Renewed lock successfully", logData);
    }, 15000);

    let processResult:
      | { ok: true; data: Awaited<ReturnType<typeof processJobInternal>> }
      | { ok: false; error: any };

    try {
      processResult = { ok: true, data: await processJobInternal(job) };
    } catch (error) {
      processResult = { ok: false, error };
    }

    clearInterval(lockRenewInterval);

    const jobDurationMs = Date.now() - jobStartTime;
    const jobDurationSeconds = Math.round(jobDurationMs / 1000);
    logger.info("Job processing completed", {
      success: processResult.ok,
      durationMs: jobDurationMs,
      durationSeconds: jobDurationSeconds,
      renewalCount,
    });

    if (processResult.ok) {
      if (
        !(await scrapeQueue.jobFinish(
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
        !(await scrapeQueue.jobFail(
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

  _logger.info("NuQ worker shutting down");

  server.close(async () => {
    await scrapeQueue.shutdown();
    _logger.info("NuQ worker shut down");
    process.exit(0);
  });
})();
