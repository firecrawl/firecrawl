import type { NuQJob } from "./nuq";
import {
  nextIdlePollDelay,
  retryWithBackoff,
  runLeasedJob,
  RuntimeLogger,
  waitForAbortableDelay,
  withOperationTimeout,
  type FenceReason,
  type LeasedJobQueue,
  type QueueOperationOptions,
} from "./nuq-worker-runtime";

export type CrawlFinishedQueue = LeasedJobQueue & {
  getJobToProcess(
    logger?: any,
    operation?: QueueOperationOptions,
  ): Promise<NuQJob<any, any> | null>;
};

export type CrawlFinishedLoop = {
  stop(): void;
  forceStop(): void;
  readonly done: Promise<void>;
  isHealthy(): boolean;
  metrics(): string;
};

// The legacy worker has a single `/health` endpoint, so transient sweeper
// health cannot be composed here without turning readiness failures into
// liveness restarts. The deployment-mode worker adds sweeper health to
// `/ready`; legacy liveness remains limited to its required finish loop.
export function isLegacyFdbWorkerLive(
  crawlFinishedLoop: Pick<CrawlFinishedLoop, "isHealthy"> | null,
): boolean {
  return crawlFinishedLoop?.isHealthy() ?? false;
}

export function startCrawlFinishedLoop(options: {
  queue: CrawlFinishedQueue;
  processJob: (job: NuQJob<any, any>, signal: AbortSignal) => Promise<void>;
  logger: RuntimeLogger;
  renewIntervalMs?: number;
  processAttempts?: number;
  retryDelaysMs?: number[];
  onFence?: (reason: FenceReason) => void;
  idleOptions?: {
    minMs?: number;
    maxMs?: number;
    jitterRatio?: number;
    random?: () => number;
  };
}): CrawlFinishedLoop {
  const stopController = new AbortController();
  const forceController = new AbortController();
  let state: "running" | "stopping" | "stopped" | "failed" = "running";
  let activeJobs = 0;
  let consecutiveProcessingErrors = 0;
  let consecutiveDequeueErrors = 0;

  const loop = (async () => {
    let idleBaseMs = options.idleOptions?.minMs ?? 500;
    let errorBaseMs = options.idleOptions?.minMs ?? 500;

    while (!stopController.signal.aborted) {
      let job: NuQJob<any, any> | null;
      try {
        job = await withOperationTimeout(
          options.queue.getJobToProcess(options.logger, { timeoutMs: 5_000 }),
          5_000,
          "crawl-finished dequeue",
        );
        consecutiveDequeueErrors = 0;
        errorBaseMs = options.idleOptions?.minMs ?? 500;
      } catch (error) {
        consecutiveDequeueErrors++;
        options.logger.error("Crawl-finished dequeue failed; retrying", {
          error,
          consecutiveDequeueErrors,
        });
        const idle = nextIdlePollDelay(errorBaseMs, options.idleOptions);
        errorBaseMs = idle.nextBaseMs;
        await waitForAbortableDelay(idle.delayMs, stopController.signal);
        continue;
      }

      if (job === null) {
        const idle = nextIdlePollDelay(idleBaseMs, options.idleOptions);
        idleBaseMs = idle.nextBaseMs;
        await waitForAbortableDelay(idle.delayMs, stopController.signal);
        continue;
      }

      if (stopController.signal.aborted) {
        options.logger.warn(
          "Dequeued crawl-finished job during shutdown; leaving lease for recovery",
          { jobId: job.id },
        );
        break;
      }

      idleBaseMs = options.idleOptions?.minMs ?? 500;
      activeJobs = 1;
      try {
        const result = await runLeasedJob({
          queue: options.queue,
          job,
          logger: options.logger,
          renewIntervalMs: options.renewIntervalMs,
          finalizationRetryDelaysMs: options.retryDelaysMs,
          shutdownSignal: forceController.signal,
          onFence: options.onFence,
          process: signal =>
            retryWithBackoff({
              attempts: options.processAttempts ?? 3,
              delaysMs: options.retryDelaysMs,
              signal,
              operation: attempt => {
                options.logger.info?.("Processing crawl-finished job", {
                  jobId: job!.id,
                  attempt,
                });
                return options.processJob(job!, signal);
              },
              onRetry: (error, attempt, delayMs) => {
                options.logger.warn(
                  "Crawl-finished processing failed transiently; retrying",
                  { jobId: job!.id, error, attempt, delayMs },
                );
              },
            }),
        });
        if (result.status === "finalization-failed") {
          consecutiveProcessingErrors++;
          options.logger.error(
            "Crawl-finished finalization exhausted retries; lease will recover",
            { jobId: job.id, error: result.error },
          );
        } else if (result.status === "fenced") {
          options.logger.warn("Crawl-finished job was fenced", {
            jobId: job.id,
            reason: result.reason,
          });
        } else if (result.status === "failed") {
          consecutiveProcessingErrors++;
        } else {
          consecutiveProcessingErrors = 0;
        }
      } catch (error) {
        // A malformed job or an unexpected runtime error must not terminate the
        // supervisor. Leave the lease to the sweeper if it could not be failed.
        consecutiveProcessingErrors++;
        options.logger.error("Crawl-finished iteration failed; continuing", {
          jobId: job.id,
          error,
          consecutiveProcessingErrors,
        });
      } finally {
        activeJobs = 0;
      }
    }
  })();

  const done = loop.then(
    () => {
      state = "stopped";
    },
    error => {
      state = "failed";
      try {
        options.logger.error("Crawl-finished supervisor stopped unexpectedly", {
          error,
        });
      } catch {
        // Logging must not turn the supervised failure into an unhandled
        // rejection. The failed state remains visible through liveness.
      }
    },
  );

  return {
    stop() {
      if (state !== "running") return;
      state = "stopping";
      stopController.abort();
    },
    forceStop() {
      if (state === "stopped" || state === "failed") return;
      state = "stopping";
      stopController.abort();
      forceController.abort();
    },
    done,
    isHealthy() {
      return state === "running";
    },
    metrics() {
      return `# HELP firecrawl_nuq_fdb_crawl_finished_loop_alive Whether the local crawl-finished supervisor is alive\n# TYPE firecrawl_nuq_fdb_crawl_finished_loop_alive gauge\nfirecrawl_nuq_fdb_crawl_finished_loop_alive ${state === "running" ? 1 : 0}\n# HELP firecrawl_nuq_fdb_crawl_finished_active_jobs Crawl-finished jobs executing in this worker process\n# TYPE firecrawl_nuq_fdb_crawl_finished_active_jobs gauge\nfirecrawl_nuq_fdb_crawl_finished_active_jobs ${activeJobs}\n# HELP firecrawl_nuq_fdb_crawl_finished_consecutive_errors Consecutive local crawl-finished processing errors\n# TYPE firecrawl_nuq_fdb_crawl_finished_consecutive_errors gauge\nfirecrawl_nuq_fdb_crawl_finished_consecutive_errors ${consecutiveProcessingErrors}\n# HELP firecrawl_nuq_fdb_crawl_finished_dequeue_errors Consecutive local crawl-finished dequeue errors\n# TYPE firecrawl_nuq_fdb_crawl_finished_dequeue_errors gauge\nfirecrawl_nuq_fdb_crawl_finished_dequeue_errors ${consecutiveDequeueErrors}\n`;
    },
  };
}
