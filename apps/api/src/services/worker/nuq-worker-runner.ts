import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { jobDurationSeconds } from "../../lib/job-metrics";
import { processJobInternal } from "./scrape-worker";
import { NuQJob } from "./nuq";
import { register } from "prom-client";
import Express from "express";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";
import type { Server } from "http";
import {
  nextIdlePollDelay,
  runLeasedJob,
  settleDrain,
  waitForAbortableDelay,
  withOperationTimeout,
  type QueueOperationOptions,
} from "./nuq-worker-runtime";

export type WorkerQueue = {
  getJobToProcess(
    logger?: any,
    operation?: QueueOperationOptions,
  ): Promise<NuQJob<any, any> | null>;
  renewLock(
    id: string,
    lock: string,
    logger?: any,
    operation?: QueueOperationOptions,
  ): Promise<boolean>;
  jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger?: any,
    operation?: QueueOperationOptions,
  ): Promise<boolean>;
  jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger?: any,
    operation?: QueueOperationOptions,
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

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

export async function runNuqWorker(options: {
  serviceName: string;
  queue: WorkerQueue;
  healthCheck: () => Promise<boolean>;
  livenessCheck?: () => boolean;
  metrics?: () => string | Promise<string>;
  beforeStart?: () => void | Promise<void>;
  onShutdownRequested?: () => void | Promise<void>;
  drain?: () => void | Promise<void>;
  onShutdownDeadline?: () => void | Promise<void>;
  beforeShutdown?: () => void | Promise<void>;
  shutdown?: () => void | Promise<void>;
  shutdownGraceMs?: number;
  processJob?: (job: NuQJob<any, any>, signal: AbortSignal) => Promise<any>;
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
  let shutdownStartedAt: number | null = null;
  let activeJobs = 0;
  const idleController = new AbortController();
  const forceActiveJobController = new AbortController();
  let resolveShutdownRequested!: () => void;
  const shutdownRequested = new Promise<void>(resolve => {
    resolveShutdownRequested = resolve;
  });

  const app = Express();

  app.get("/metrics", async (_, res) => {
    try {
      const localMetrics = options.metrics ? await options.metrics() : "";
      const runtimeMetrics = `# HELP firecrawl_nuq_worker_active_jobs Number of jobs executing in this worker process\n# TYPE firecrawl_nuq_worker_active_jobs gauge\nfirecrawl_nuq_worker_active_jobs{service="${options.serviceName}"} ${activeJobs}\n`;
      res
        .contentType("text/plain")
        .send(
          localMetrics + "\n" + runtimeMetrics + (await register.metrics()),
        );
    } catch (error) {
      _logger.warn("NuQ worker metrics collection failed", {
        module: options.serviceName,
        error,
      });
      res.status(500).send("Metrics unavailable");
    }
  });
  app.get("/health", async (_, res) => {
    try {
      if (options.livenessCheck && !options.livenessCheck()) {
        res.status(500).send("Not OK");
        return;
      }
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

  function requestShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    shutdownStartedAt = Date.now();
    idleController.abort();
    resolveShutdownRequested();
    void Promise.resolve(options.onShutdownRequested?.()).catch(error => {
      _logger.error("NuQ worker shutdown notification failed", {
        module: options.serviceName,
        error,
      });
    });
  }

  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  const loop = (async () => {
    let idleBaseMs = 500;
    let dequeueErrorBaseMs = 500;

    while (!isShuttingDown) {
      let job: NuQJob<any, any> | null;
      try {
        job = await withOperationTimeout(
          options.queue.getJobToProcess(undefined, { timeoutMs: 5_000 }),
          5_000,
          "job dequeue",
        );
        dequeueErrorBaseMs = 500;
      } catch (error) {
        _logger.error("Failed to dequeue NuQ job", {
          module: options.serviceName,
          error,
        });
        const idle = nextIdlePollDelay(dequeueErrorBaseMs);
        dequeueErrorBaseMs = idle.nextBaseMs;
        await waitForAbortableDelay(idle.delayMs, idleController.signal);
        continue;
      }

      if (job === null) {
        const idle = nextIdlePollDelay(idleBaseMs);
        idleBaseMs = idle.nextBaseMs;
        await waitForAbortableDelay(idle.delayMs, idleController.signal);
        continue;
      }

      if (isShuttingDown) {
        _logger.warn(
          "Dequeued a job while shutdown was requested; leaving its lease for recovery",
          { module: options.serviceName, jobId: job.id },
        );
        break;
      }

      idleBaseMs = 500;

      const logger = _logger.child({
        module: options.serviceName,
        scrapeId: job.id,
        zeroDataRetention: job.data?.zeroDataRetention ?? false,
      });

      logger.info("Acquired job");
      activeJobs = 1;
      const endJobTimer = jobDurationSeconds.startTimer({
        type: job.data.mode,
      });
      try {
        const result = await runLeasedJob({
          queue: options.queue,
          job,
          logger,
          shutdownSignal: forceActiveJobController.signal,
          onFence: reason => {
            if (reason === "shutdown") return;
            logger.error(
              "Worker lost job ownership; terminating to abort stale side effects",
              { reason },
            );
            // The AbortSignal passed below cancels scraper engines immediately;
            // process exit remains the final fence for non-cooperative external
            // code in this single-job worker process.
            setImmediate(() => process.exit(1));
          },
          process: signal =>
            options.processJob
              ? options.processJob(job!, signal)
              : processJobInternal(job!, signal),
        });

        if (result.status === "completed") {
          endJobTimer({ status: "success" });
        } else {
          endJobTimer({ status: "failed" });
          if (result.status === "fenced") {
            logger.warn("Job was fenced and will not be finalized", {
              reason: result.reason,
            });
          }
        }
      } catch (error) {
        endJobTimer({ status: "failed" });
        logger.error("Unexpected NuQ job lifecycle failure; continuing", {
          error,
        });
      } finally {
        activeJobs = 0;
      }
    }
  })();

  // Wait indefinitely during normal operation. Once shutdown is requested,
  // stop dequeuing and let the active job retain/renew its lease while it drains.
  await Promise.race([loop, shutdownRequested]);
  let drained = false;
  if (isShuttingDown) {
    const drain = settleDrain(
      [loop, Promise.resolve().then(() => options.drain?.())],
      error => {
        _logger.error("NuQ worker drain failed", {
          module: options.serviceName,
          error,
        });
      },
    );
    const graceController = new AbortController();
    drained =
      (await Promise.race([
        drain,
        waitForAbortableDelay(
          Math.max(
            0,
            (options.shutdownGraceMs ?? 30_000) -
              (shutdownStartedAt === null ? 0 : Date.now() - shutdownStartedAt),
          ),
          graceController.signal,
        ).then(() => false),
      ])) === true;
    graceController.abort();
  } else {
    await loop;
    drained = true;
  }

  if (!drained) {
    _logger.warn("NuQ worker drain deadline exceeded; fencing active job", {
      module: options.serviceName,
    });
    forceActiveJobController.abort();
    try {
      void Promise.resolve(options.onShutdownDeadline?.()).catch(error => {
        _logger.error("NuQ worker deadline hook failed", {
          module: options.serviceName,
          error,
        });
      });
    } catch (error) {
      _logger.error("NuQ worker deadline hook failed", {
        module: options.serviceName,
        error,
      });
    }
  }

  _logger.info("NuQ worker shutting down", {
    module: options.serviceName,
    drained,
  });

  process.off("SIGINT", requestShutdown);
  process.off("SIGTERM", requestShutdown);

  const remainingShutdownMs = () =>
    shutdownStartedAt === null
      ? 10_000
      : Math.max(
          0,
          (options.shutdownGraceMs ?? 30_000) -
            (Date.now() - shutdownStartedAt),
        );
  try {
    await withTimeout(
      closeServer(server),
      Math.min(10_000, remainingShutdownMs()),
      "HTTP shutdown",
    );
  } catch (error) {
    _logger.warn("NuQ worker HTTP shutdown did not complete cleanly", {
      module: options.serviceName,
      error,
    });
  }
  try {
    await withTimeout(
      Promise.resolve(options.beforeShutdown?.()).then(() =>
        options.shutdown?.(),
      ),
      Math.min(10_000, remainingShutdownMs()),
      "worker cleanup",
    );
  } catch (error) {
    _logger.error("NuQ worker cleanup failed", {
      module: options.serviceName,
      error,
    });
  }

  _logger.info("NuQ worker shut down", { module: options.serviceName });
  process.exit(0);
}
