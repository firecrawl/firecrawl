import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { jobDurationSeconds } from "../../lib/job-metrics";
import { processJobInternal } from "./scrape-worker";
import { NuQJob } from "./nuq";
import { register } from "prom-client";
import { createNuqWorkerHttpApp } from "./nuq-worker-http";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";
import { initializeEngineForcing } from "../../scraper/WebScraper/utils/engine-forcing";
import type { Server } from "http";
import {
  nextIdlePollDelay,
  runLeasedJob,
  settleDrain,
  superviseRequiredWorkerLoops,
  waitForAbortableDelay,
  withOperationTimeout,
  type QueueOperationOptions,
  type RequiredWorkerLoop,
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

export type WorkerSignalSource = {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export type RunNuqWorkerHost = {
  initialize?: () => void | Promise<void>;
  signalSource?: WorkerSignalSource;
  port?: number;
  onServerStarted?: (server: Server) => void;
  exit?: (code: number) => void;
};

export type RunNuqWorkerOptions = {
  serviceName: string;
  queue: WorkerQueue;
  healthCheck: () => Promise<boolean>;
  /** @deprecated Use requiredLoops. */
  livenessCheck?: () => boolean;
  requiredLoops?: () => readonly RequiredWorkerLoop[];
  metrics?: () => string | Promise<string>;
  beforeStart?: () => void | Promise<void>;
  onShutdownRequested?: () => void | Promise<void>;
  drain?: () => void | Promise<void>;
  onShutdownDeadline?: () => void | Promise<void>;
  beforeShutdown?: () => void | Promise<void>;
  shutdown?: () => void | Promise<void>;
  shutdownGraceMs?: number;
  processJob?: (job: NuQJob<any, any>, signal: AbortSignal) => Promise<any>;
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

export async function runNuqWorker(
  options: RunNuqWorkerOptions,
  host: RunNuqWorkerHost = {},
) {
  const signalSource = host.signalSource ?? process;
  const exit = host.exit ?? ((code: number) => process.exit(code));

  try {
    if (host.initialize) {
      await host.initialize();
    } else {
      await initializeBlocklist();
      initializeEngineForcing();
    }
    await options.beforeStart?.();
  } catch (error) {
    _logger.error("Failed to initialize NuQ worker", {
      module: options.serviceName,
      error,
    });
    exit(1);
    return;
  }

  let isShuttingDown = false;
  let shutdownStartedAt: number | null = null;
  let activeJobs = 0;
  let fatalRequiredLoopError: unknown = null;
  const requiredLoops = options.requiredLoops?.() ?? [];
  const idleController = new AbortController();
  const forceActiveJobController = new AbortController();
  let resolveShutdownRequested!: () => void;
  const shutdownRequested = new Promise<void>(resolve => {
    resolveShutdownRequested = resolve;
  });

  const app = createNuqWorkerHttpApp({
    isDraining: () => isShuttingDown,
    dependencyReady: options.healthCheck,
    requiredLoopsReady: () =>
      requiredLoops.every(requiredLoop => requiredLoop.isHealthy()) &&
      (options.livenessCheck?.() ?? true),
    metrics: async () => {
      const localMetrics = options.metrics ? await options.metrics() : "";
      const runtimeMetrics = `# HELP firecrawl_nuq_worker_active_jobs Number of jobs executing in this worker process\n# TYPE firecrawl_nuq_worker_active_jobs gauge\nfirecrawl_nuq_worker_active_jobs{service="${options.serviceName}"} ${activeJobs}\n`;
      return localMetrics + "\n" + runtimeMetrics + (await register.metrics());
    },
    onReadinessError: error => {
      _logger.warn("NuQ worker readiness check failed", {
        module: options.serviceName,
        error,
      });
    },
    onMetricsError: error => {
      _logger.warn("NuQ worker metrics collection failed", {
        module: options.serviceName,
        error,
      });
    },
  });

  const port = host.port ?? config.NUQ_WORKER_PORT;
  const server = app.listen(port, () => {
    _logger.info("NuQ worker metrics server started", {
      module: options.serviceName,
      port,
    });
    host.onServerStarted?.(server);
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

  signalSource.on("SIGINT", requestShutdown);
  signalSource.on("SIGTERM", requestShutdown);

  superviseRequiredWorkerLoops(
    requiredLoops,
    () => isShuttingDown,
    (loop, error) => {
      fatalRequiredLoopError = error;
      _logger.error("NuQ worker required loop failed", {
        module: options.serviceName,
        loop,
        error,
      });
      requestShutdown();
    },
  );

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
            // processJobInternal does not yet accept an AbortSignal. Exiting the
            // single-job worker is the only hard cancellation boundary that
            // prevents the stale owner from continuing crawl/scrape effects.
            setImmediate(() => exit(1));
          },
          process: signal =>
            options.processJob
              ? options.processJob(job!, signal)
              : processJobInternal(job!),
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

  signalSource.off("SIGINT", requestShutdown);
  signalSource.off("SIGTERM", requestShutdown);

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
  exit(fatalRequiredLoopError === null ? 0 : 1);
}
