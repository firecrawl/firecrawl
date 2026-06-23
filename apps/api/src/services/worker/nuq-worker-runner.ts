import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { jobDurationSeconds } from "../../lib/job-metrics";
import { processJobInternal } from "./scrape-worker";
import { NuQJob } from "./nuq";
import { register } from "prom-client";
import Express from "express";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";

export type WorkerQueue = {
  getJobToProcess(logger?: any): Promise<NuQJob<any, any> | null>;
  renewLock(id: string, lock: string, logger?: any): Promise<boolean>;
  jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger?: any,
  ): Promise<boolean>;
  jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger?: any,
  ): Promise<boolean>;
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runNuqWorker(options: {
  serviceName: string;
  queue: WorkerQueue;
  healthCheck: () => Promise<boolean>;
  metrics?: () => string | Promise<string>;
  beforeStart?: () => void | Promise<void>;
  beforeShutdown?: () => void | Promise<void>;
  shutdown?: () => void | Promise<void>;
}) {
  try {
    await initializeBlocklist();
    initializeEngineForcing();
    await options.beforeStart?.();
  } catch (error) {
    _logger.error("Failed to initialize NuQ worker", {
      module: options.serviceName,
      error,
    });
    process.exit(1);
  }

  let isShuttingDown = false;

  const app = Express();

  app.get("/metrics", async (_, res) => {
    const localMetrics = options.metrics ? await options.metrics() : "";
    res
      .contentType("text/plain")
      .send(localMetrics + "\n" + (await register.metrics()));
  });
  app.get("/health", async (_, res) => {
    try {
      if (await withTimeout(options.healthCheck(), 1000, "NuQ health check")) {
        res.status(200).send("OK");
      } else {
        res.status(500).send("Not OK");
      }
    } catch (error) {
      _logger.warn("NuQ worker health check failed", {
        module: options.serviceName,
        error,
      });
      res.status(500).send("Not OK");
    }
  });

  const server = app.listen(config.NUQ_WORKER_PORT, (error?: Error) => {
    if (error) {
      _logger.error("Failed to start NuQ worker metrics server", {
        module: options.serviceName,
        error,
        port: config.NUQ_WORKER_PORT,
      });
      throw error;
    }

    _logger.info("NuQ worker metrics server started", {
      module: options.serviceName,
    });
  });

  function shutdown() {
    isShuttingDown = true;
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let noJobTimeout = 1500;

  while (!isShuttingDown) {
    const job = await options.queue.getJobToProcess();

    if (job === null) {
      _logger.info("No jobs to process", { module: "nuq/metrics" });
      await new Promise(resolve => setTimeout(resolve, noJobTimeout));
      if (!config.NUQ_RABBITMQ_URL) {
        noJobTimeout = Math.min(noJobTimeout * 2, 10000);
      }
      continue;
    }

    noJobTimeout = 500;

    const logger = _logger.child({
      module: options.serviceName,
      scrapeId: job.id,
      zeroDataRetention: job.data?.zeroDataRetention ?? false,
    });

    logger.info("Acquired job");

    const lockRenewInterval = setInterval(async () => {
      try {
        logger.info("Renewing lock");
        if (!(await options.queue.renewLock(job.id, job.lock!, logger))) {
          logger.warn("Failed to renew lock");
          clearInterval(lockRenewInterval);
          return;
        }
        logger.info("Renewed lock");
      } catch (error) {
        logger.warn("Failed to renew lock", { error });
        clearInterval(lockRenewInterval);
      }
    }, 15000);

    let processResult:
      | { ok: true; data: Awaited<ReturnType<typeof processJobInternal>> }
      | { ok: false; error: any };

    const endJobTimer = jobDurationSeconds.startTimer({ type: job.data.mode });

    try {
      processResult = { ok: true, data: await processJobInternal(job) };
    } catch (error) {
      processResult = { ok: false, error };
    }

    clearInterval(lockRenewInterval);

    if (processResult.ok) {
      endJobTimer({ status: "success" });
      if (
        !(await options.queue.jobFinish(
          job.id,
          job.lock!,
          processResult.data,
          logger,
        ))
      ) {
        logger.warn("Could not update job status");
      }
    } else {
      endJobTimer({ status: "failed" });
      if (
        !(await options.queue.jobFail(
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

  _logger.info("NuQ worker shutting down", { module: options.serviceName });

  server.close(async () => {
    await options.beforeShutdown?.();
    await options.shutdown?.();
    _logger.info("NuQ worker shut down", { module: options.serviceName });
    process.exit(0);
  });
}
