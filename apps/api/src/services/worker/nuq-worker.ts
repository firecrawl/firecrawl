import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { processJobInternal } from "./scrape-worker";
import { finalizeJobWithRetry } from "./job-finalizer";
import { scrapeQueue, nuqGetLocalMetrics, nuqHealthCheck } from "./nuq";
import Express from "express";
import { _ } from "ajv";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";

(async () => {
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

  const server = app.listen(
    Number(process.env.NUQ_WORKER_PORT ?? process.env.PORT ?? 3000),
    () => {
      _logger.info("NuQ worker metrics server started");
    },
  );

  function shutdown() {
    isShuttingDown = true;
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let noJobTimeout = 1500;
  const stallAlertThreshold =
    Number(process.env.NUQ_STALL_ALERT_THRESHOLD) || 7;

  while (!isShuttingDown) {
    const job = await scrapeQueue.getJobToProcess();

    if (job === null) {
      _logger.info("No jobs to process", { module: "nuq/metrics" });
      await new Promise(resolve => setTimeout(resolve, noJobTimeout));
      if (!process.env.NUQ_RABBITMQ_URL) {
        noJobTimeout = Math.min(noJobTimeout * 2, 10000);
      }
      continue;
    }

    noJobTimeout = 500;

    const logger = _logger.child({
      module: "nuq-worker",
      scrapeId: job.id,
      zeroDataRetention: job.data?.zeroDataRetention ?? false,
    });

    logger.info("Acquired job");

    if (typeof job.stalls === "number" && job.stalls >= stallAlertThreshold) {
      logger.warn("Job has high stall count", {
        jobId: job.id,
        stalls: job.stalls,
        threshold: stallAlertThreshold,
      });
    }

    const lockRenewInterval = setInterval(async () => {
      logger.info("Renewing lock");
      if (!(await scrapeQueue.renewLock(job.id, job.lock!, logger))) {
        logger.warn("Failed to renew lock");
        clearInterval(lockRenewInterval);
        return;
      }
      logger.info("Renewed lock");
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

    if (processResult.ok) {
      await finalizeJobWithRetry(
        "finish",
        () =>
          scrapeQueue.jobFinish(job.id, job.lock!, processResult.data, logger),
        job.id,
        logger,
      );
    } else {
      await finalizeJobWithRetry(
        "fail",
        () =>
          scrapeQueue.jobFail(
            job.id,
            job.lock!,
            processResult.error instanceof Error
              ? processResult.error.message
              : typeof processResult.error === "string"
                ? processResult.error
                : JSON.stringify(processResult.error),
            logger,
          ),
        job.id,
        logger,
      );
    }
  }

  _logger.info("NuQ worker shutting down");

  server.close(async () => {
    await scrapeQueue.shutdown();
    _logger.info("NuQ worker shut down");
    process.exit(0);
  });
})();
