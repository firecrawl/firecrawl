import { afterEach, describe, expect, test, vi } from "vitest";
import {
  nextIdlePollDelay,
  runLeasedJob,
  settleDrain,
  type RuntimeLogger,
} from "./nuq-worker-runtime";
import {
  isLegacyFdbWorkerLive,
  startCrawlFinishedLoop,
} from "./nuq-fdb-worker-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const logger: RuntimeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function job() {
  return {
    backend: "fdb" as const,
    id: "job-1",
    data: { mode: "single_urls" },
    lock: "lock-1",
    status: "active" as const,
    createdAt: new Date(),
    priority: 0,
  };
}

function queue(overrides: Record<string, unknown> = {}) {
  return {
    renewLock: vi.fn().mockResolvedValue(true),
    jobFinish: vi.fn().mockResolvedValue(true),
    jobFail: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("NuQ worker lease lifecycle", () => {
  test("retries transient renewal errors with bounded backoff", async () => {
    vi.useFakeTimers();
    const processing = deferred<string>();
    const renewLock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(true);
    const q = queue({ renewLock });

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      renewIntervalMs: 10,
      renewalRetryDelaysMs: [5],
      process: () => processing.promise,
    });

    await vi.advanceTimersByTimeAsync(15);
    expect(renewLock).toHaveBeenCalledTimes(2);
    processing.resolve("ok");

    await expect(running).resolves.toEqual({ status: "completed" });
    expect(q.jobFinish).toHaveBeenCalledTimes(1);
  });

  test("fences a hung renewal without starting an overlapping callback", async () => {
    vi.useFakeTimers();
    const renewLock = vi.fn(() => new Promise<boolean>(() => {}));
    const q = queue({ renewLock });
    const onFence = vi.fn();

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      renewIntervalMs: 10,
      renewalTimeoutMs: 5,
      onFence,
      process: signal =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    await vi.advanceTimersByTimeAsync(15);
    await expect(running).resolves.toEqual({
      status: "fenced",
      reason: "renewal-failed",
    });
    expect(renewLock).toHaveBeenCalledTimes(1);
    expect(renewLock).toHaveBeenCalledWith("job-1", "lock-1", logger, {
      timeoutMs: 5,
    });
    expect(onFence).toHaveBeenCalledWith("renewal-failed");
  });

  test("aborts and fences processing after confirmed lock loss", async () => {
    vi.useFakeTimers();
    const q = queue({ renewLock: vi.fn().mockResolvedValue(false) });
    const onFence = vi.fn();
    let observedAbort = false;

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      renewIntervalMs: 10,
      onFence,
      process: signal =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(running).resolves.toEqual({
      status: "fenced",
      reason: "lock-lost",
    });
    expect(observedAbort).toBe(true);
    expect(onFence).toHaveBeenCalledWith("lock-lost");
    expect(q.jobFinish).not.toHaveBeenCalled();
    expect(q.jobFail).not.toHaveBeenCalled();
  });

  test("awaits an overlapping renewal before finishing", async () => {
    vi.useFakeTimers();
    const processing = deferred<string>();
    const renewal = deferred<boolean>();
    const q = queue({ renewLock: vi.fn(() => renewal.promise) });

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      renewIntervalMs: 10,
      process: () => processing.promise,
    });

    await vi.advanceTimersByTimeAsync(10);
    processing.resolve("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(q.jobFinish).not.toHaveBeenCalled();

    renewal.resolve(true);
    await expect(running).resolves.toEqual({ status: "completed" });
    expect(q.jobFinish).toHaveBeenCalledTimes(1);
  });

  test("retries transient finalization without overlapping renewal", async () => {
    vi.useFakeTimers();
    const jobFinish = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit unknown"))
      .mockResolvedValue(true);
    const q = queue({ jobFinish });

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      finalizationRetryDelaysMs: [5],
      process: async () => "ok",
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(running).resolves.toEqual({ status: "completed" });
    expect(jobFinish).toHaveBeenCalledTimes(2);
    expect(q.renewLock).not.toHaveBeenCalled();
  });

  test("fences a hung finalization instead of wedging without renewals", async () => {
    vi.useFakeTimers();
    const jobFinish = vi.fn(() => new Promise<boolean>(() => {}));
    const q = queue({ jobFinish });
    const onFence = vi.fn();

    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      finalizationTimeoutMs: 5,
      onFence,
      process: async () => "ok",
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(running).resolves.toEqual({
      status: "fenced",
      reason: "finalization-timeout",
    });
    expect(jobFinish).toHaveBeenCalledTimes(1);
    expect(jobFinish).toHaveBeenCalledWith("job-1", "lock-1", "ok", logger, {
      timeoutMs: 5,
    });
    expect(onFence).toHaveBeenCalledWith("finalization-timeout");
  });

  test("does not start work when the shutdown fence is already active", async () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const q = queue();
    const process = vi.fn().mockResolvedValue("unexpected");

    await expect(
      runLeasedJob({
        queue: q,
        job: job(),
        logger,
        shutdownSignal: shutdown.signal,
        process,
      }),
    ).resolves.toEqual({ status: "fenced", reason: "shutdown" });
    expect(process).not.toHaveBeenCalled();
    expect(q.renewLock).not.toHaveBeenCalled();
    expect(q.jobFinish).not.toHaveBeenCalled();
  });

  test("forced shutdown aborts and fences an over-deadline job", async () => {
    const shutdown = new AbortController();
    const q = queue();
    const running = runLeasedJob({
      queue: q,
      job: job(),
      logger,
      shutdownSignal: shutdown.signal,
      process: signal =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    shutdown.abort();
    await expect(running).resolves.toEqual({
      status: "fenced",
      reason: "shutdown",
    });
    expect(q.jobFinish).not.toHaveBeenCalled();
    expect(q.jobFail).not.toHaveBeenCalled();
  });
});

describe("NuQ FDB worker supervision", () => {
  test("keeps transient sweeper readiness out of legacy liveness", () => {
    const crawlFinishedLoop = { isHealthy: vi.fn(() => true) };

    expect(isLegacyFdbWorkerLive(crawlFinishedLoop)).toBe(true);
    expect(crawlFinishedLoop.isHealthy).toHaveBeenCalledOnce();
    expect(isLegacyFdbWorkerLive(null)).toBe(false);
  });

  test("keeps crawl-finished loop healthy through transient dequeue and finish failures", async () => {
    vi.useFakeTimers();
    const directFdbJob = job();
    const getJobToProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error("FDB unavailable"))
      .mockResolvedValueOnce(directFdbJob)
      .mockResolvedValue(null);
    const jobFinish = vi
      .fn()
      .mockRejectedValueOnce(new Error("commit unknown"))
      .mockResolvedValue(true);
    const q = {
      ...queue({ jobFinish }),
      getJobToProcess,
    };
    const processJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient finalizer dependency"))
      .mockResolvedValue(undefined);

    const loop = startCrawlFinishedLoop({
      queue: q,
      processJob,
      logger,
      renewIntervalMs: 10_000,
      processAttempts: 2,
      retryDelaysMs: [5],
      idleOptions: {
        minMs: 10,
        maxMs: 40,
        jitterRatio: 0,
        random: () => 0.5,
      },
    });

    expect(loop.isHealthy()).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(getJobToProcess).toHaveBeenCalledWith(logger, { timeoutMs: 5_000 });
    expect(processJob).toHaveBeenCalledTimes(2);
    expect(processJob.mock.calls[0][0].backend).toBe("fdb");
    expect(jobFinish).toHaveBeenCalledTimes(2);
    expect(loop.isHealthy()).toBe(true);
    expect(loop.metrics()).toContain(
      "firecrawl_nuq_fdb_crawl_finished_loop_alive 1",
    );

    loop.stop();
    await loop.done;
    expect(loop.isHealthy()).toBe(false);
  });

  test("turns an unexpected supervisor rejection into unhealthy state", async () => {
    let errorCalls = 0;
    const rejectingLogger: RuntimeLogger = {
      ...logger,
      error: () => {
        errorCalls++;
        throw new Error("logger transport failed");
      },
    };
    const loop = startCrawlFinishedLoop({
      queue: {
        ...queue(),
        getJobToProcess: vi.fn().mockRejectedValue(new Error("dequeue failed")),
      },
      processJob: vi.fn(),
      logger: rejectingLogger,
    });

    await expect(loop.done).resolves.toBeUndefined();
    expect(loop.isHealthy()).toBe(false);
    expect(errorCalls).toBe(2);
  });

  test("bounds a hung dequeue so shutdown can settle", async () => {
    vi.useFakeTimers();
    const loop = startCrawlFinishedLoop({
      queue: {
        ...queue(),
        getJobToProcess: vi.fn(
          () => new Promise<ReturnType<typeof job> | null>(() => {}),
        ),
      },
      processJob: vi.fn(),
      logger,
    });

    loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(loop.done).resolves.toBeUndefined();
  });

  test("does not start a crawl-finished job returned after shutdown", async () => {
    const dequeued = deferred<ReturnType<typeof job> | null>();
    const q = {
      ...queue(),
      getJobToProcess: vi.fn(() => dequeued.promise),
    };
    const processJob = vi.fn().mockResolvedValue(undefined);
    const loop = startCrawlFinishedLoop({ queue: q, processJob, logger });

    loop.stop();
    dequeued.resolve(job());
    await loop.done;

    expect(processJob).not.toHaveBeenCalled();
    expect(q.jobFinish).not.toHaveBeenCalled();
    expect(q.jobFail).not.toHaveBeenCalled();
  });

  test("keeps failed-processing metrics until a successful job", async () => {
    vi.useFakeTimers();
    const q = {
      ...queue(),
      getJobToProcess: vi
        .fn()
        .mockResolvedValueOnce(job())
        .mockResolvedValue(null),
    };
    const loop = startCrawlFinishedLoop({
      queue: q,
      processJob: vi.fn().mockRejectedValue(new Error("permanent")),
      processAttempts: 1,
      logger,
      idleOptions: { minMs: 10, maxMs: 10, jitterRatio: 0 },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(loop.metrics()).toContain(
      "firecrawl_nuq_fdb_crawl_finished_consecutive_errors 1",
    );
    loop.stop();
    await loop.done;
  });

  test("force-stops an over-deadline crawl-finished job without finalizing", async () => {
    const q = {
      ...queue(),
      getJobToProcess: vi
        .fn()
        .mockResolvedValueOnce(job())
        .mockResolvedValue(null),
    };
    let processingStarted!: () => void;
    const started = new Promise<void>(resolve => {
      processingStarted = resolve;
    });
    const loop = startCrawlFinishedLoop({
      queue: q,
      logger,
      processJob: (_job, signal) =>
        new Promise((_, reject) => {
          processingStarted();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    await started;
    loop.stop();
    expect(loop.isHealthy()).toBe(false);
    loop.forceStop();
    await loop.done;
    expect(q.jobFinish).not.toHaveBeenCalled();
    expect(q.jobFail).not.toHaveBeenCalled();
  });

  test("converts drain rejection into an undrained result", async () => {
    const onError = vi.fn();
    await expect(
      settleDrain(
        [Promise.resolve(), Promise.reject(new Error("drain failed"))],
        onError,
      ),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledOnce();
  });

  test("uses exponential jittered idle polling independent of RabbitMQ", () => {
    expect(
      nextIdlePollDelay(500, {
        minMs: 500,
        maxMs: 10_000,
        jitterRatio: 0.2,
        random: () => 0,
      }),
    ).toEqual({ delayMs: 400, nextBaseMs: 1000 });
    expect(
      nextIdlePollDelay(10_000, {
        minMs: 500,
        maxMs: 10_000,
        jitterRatio: 0.2,
        random: () => 1,
      }),
    ).toEqual({ delayMs: 10_000, nextBaseMs: 10_000 });
  });
});
