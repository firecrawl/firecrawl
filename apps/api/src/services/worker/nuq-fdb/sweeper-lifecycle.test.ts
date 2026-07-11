import type { Logger } from "winston";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../config";
import type { NuqFdbKeyspace } from "./keyspace";
import type { NuQFdbQueue } from "./queue";
import { NuqFdbSweeper } from "./sweeper";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;
const previousMetricsActivation = config.NUQ_FDB_METRICS_V2_ACTIVATE;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeSweeper(
  options: ConstructorParameters<typeof NuqFdbSweeper>[2] = {},
) {
  const ks = { queueName: "lifecycle-test" } as NuqFdbKeyspace;
  const queue = { ks } as NuQFdbQueue;
  return { ks, sweeper: new NuqFdbSweeper([queue], [], options) };
}

function observeDelay(
  sweeper: NuqFdbSweeper,
  ks: NuqFdbKeyspace,
  lifecycleGeneration?: number,
) {
  (sweeper as any).observeDue(
    {
      ks,
      phase: "delay",
      partition: 3,
      generation: "test",
      expiresAt: 10_000,
      lifecycleGeneration,
    },
    "delay",
    [[Buffer.alloc(0), Buffer.alloc(0)]],
    () => 1_000,
  );
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("NuqFdbSweeper lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Lifecycle backfill tests model the activated release-B sweeper. Disabled
    // rollout behavior is covered separately by the metric invalidation tests.
    config.NUQ_FDB_METRICS_V2_ACTIVATE = true;
  });

  afterEach(() => {
    config.NUQ_FDB_METRICS_V2_ACTIVATE = previousMetricsActivation;
    vi.useRealTimers();
  });

  it("survives repeated native FDB failures and becomes healthy after recovery", async () => {
    const { sweeper } = makeSweeper();
    const outage = Object.assign(new Error("FDB unavailable"), { code: 1031 });
    const sweepOnce = vi
      .spyOn(sweeper, "sweepOnce")
      .mockRejectedValueOnce(outage)
      .mockRejectedValueOnce(outage)
      .mockResolvedValue(undefined);

    sweeper.start(10, logger);
    const done = sweeper.done;
    const settled = vi.fn();
    void done.then(settled, settled);

    await vi.advanceTimersByTimeAsync(10);
    expect(sweepOnce).toHaveBeenCalledTimes(1);
    expect(sweeper.isHealthy()).toBe(false);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(sweepOnce).toHaveBeenCalledTimes(2);
    expect(sweeper.isHealthy()).toBe(false);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);
    expect(sweepOnce).toHaveBeenCalledTimes(3);
    expect(sweeper.isHealthy()).toBe(true);
    expect(settled).not.toHaveBeenCalled();

    sweeper.stop();
    await expect(done).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("treats a separately classified programmer failure as fatal without an unhandled rejection", async () => {
    const retryable = new Error("retryable test error");
    const failure = new Error("invariant violated");
    const classifyTickError = vi.fn((error: unknown) =>
      error === retryable ? ("transient" as const) : ("fatal" as const),
    );
    const { ks, sweeper } = makeSweeper({ classifyTickError });
    vi.spyOn(sweeper, "sweepOnce").mockRejectedValue(failure);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      observeDelay(sweeper, ks);
      sweeper.start(10, logger);
      const done = sweeper.done;
      await vi.advanceTimersByTimeAsync(10);
      await flushPromises();

      expect(classifyTickError).toHaveBeenCalledWith(failure);
      expect(sweeper.isHealthy()).toBe(false);
      expect(sweeper.getMetrics(2_000)).not.toContain('index="delay"');
      await expect(done).rejects.toBe(failure);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("does not classify an unmarked generic error as transient by default", async () => {
    const { sweeper } = makeSweeper();
    const failure = new Error("generic failure");
    vi.spyOn(sweeper, "sweepOnce").mockRejectedValue(failure);

    sweeper.start(10, logger);
    const done = sweeper.done;
    await vi.advanceTimersByTimeAsync(10);

    await expect(done).rejects.toBe(failure);
    expect(sweeper.isHealthy()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweeper.sweepOnce).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "transient",
      tickError: Object.assign(new Error("FDB unavailable"), { code: 1031 }),
      loggingMethod: "warn" as const,
    },
    {
      name: "fatal",
      tickError: new Error("programmer failure"),
      loggingMethod: "error" as const,
    },
  ])(
    "fails the lifecycle when $name failure logging throws",
    async ({ tickError, loggingMethod }) => {
      const { sweeper } = makeSweeper();
      const loggingFailure = new Error(`${loggingMethod} failed`);
      const throwingLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        [loggingMethod]: vi.fn(() => {
          throw loggingFailure;
        }),
      } as unknown as Logger;
      const sweepOnce = vi
        .spyOn(sweeper, "sweepOnce")
        .mockRejectedValue(tickError);

      sweeper.start(10, throwingLogger);
      const done = sweeper.done;
      await vi.advanceTimersByTimeAsync(10);

      await expect(done).rejects.toBe(loggingFailure);
      expect(sweeper.isHealthy()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(sweepOnce).toHaveBeenCalledOnce();
    },
  );

  it("fails the lifecycle if its injected classifier throws", async () => {
    const classifierFailure = new Error("classifier failed");
    const { sweeper } = makeSweeper({
      classifyTickError: () => {
        throw classifierFailure;
      },
    });
    vi.spyOn(sweeper, "sweepOnce").mockRejectedValue(new Error("tick failed"));

    sweeper.start(10, logger);
    const done = sweeper.done;
    await vi.advanceTimersByTimeAsync(10);

    await expect(done).rejects.toBe(classifierFailure);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(sweeper.isHealthy()).toBe(false);
  });

  it("stops new ticks and settles done only after the in-flight pass", async () => {
    const { sweeper } = makeSweeper();
    const inFlight = deferred();
    const sweepOnce = vi
      .spyOn(sweeper, "sweepOnce")
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue(undefined);

    sweeper.start(10, logger);
    const firstDone = sweeper.done;
    const settled = vi.fn();
    void firstDone.then(settled);
    await vi.advanceTimersByTimeAsync(10);
    expect(sweepOnce).toHaveBeenCalledOnce();

    sweeper.stop();
    sweeper.stop();
    expect(sweeper.isHealthy()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sweepOnce).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    inFlight.resolve();
    await expect(firstDone).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledOnce();

    sweeper.start(10, logger);
    const restartedDone = sweeper.done;
    sweeper.start(10, logger);
    expect(restartedDone).not.toBe(firstDone);
    await vi.advanceTimersByTimeAsync(10);
    expect(sweepOnce).toHaveBeenCalledTimes(2);
    sweeper.stop();
    await expect(restartedDone).resolves.toBeUndefined();
  });

  it("invalidates queue metric generations while release-B activation is disabled", async () => {
    config.NUQ_FDB_METRICS_V2_ACTIVATE = false;
    const queue = {
      ks: { queueName: "disabled" },
      invalidateMetricCounterGeneration: vi.fn().mockResolvedValue(true),
      backfillMetricCounts: vi.fn(),
    } as unknown as NuQFdbQueue;
    const sweeper = new NuqFdbSweeper([queue]);

    await sweeper.sweepOnce(logger, 0);

    expect(queue.invalidateMetricCounterGeneration).toHaveBeenCalledOnce();
    expect(queue.backfillMetricCounts).not.toHaveBeenCalled();
  });

  it("does not continue queue backfills after force-stop and restart", async () => {
    const firstBackfill = deferred();
    const firstQueue = {
      ks: { queueName: "first" },
      backfillMetricCounts: vi.fn(() => firstBackfill.promise),
    } as unknown as NuQFdbQueue;
    const secondQueue = {
      ks: { queueName: "second" },
      backfillMetricCounts: vi.fn().mockResolvedValue(undefined),
    } as unknown as NuQFdbQueue;
    const sweeper = new NuqFdbSweeper([firstQueue, secondQueue]);

    sweeper.start(10, logger);
    const detachedDone = sweeper.done;
    await vi.advanceTimersByTimeAsync(10);
    expect(firstQueue.backfillMetricCounts).toHaveBeenCalledOnce();

    sweeper.forceStop();
    await detachedDone;
    sweeper.start(100, logger);
    const restartedDone = sweeper.done;
    firstBackfill.resolve();
    await flushPromises();

    expect(secondQueue.backfillMetricCounts).not.toHaveBeenCalled();
    expect(sweeper.isHealthy()).toBe(true);
    sweeper.forceStop();
    await restartedDone;
  });

  it("does not let a stale renewal extend a restarted lifecycle's metric", async () => {
    const { ks, sweeper } = makeSweeper();
    let finishRenewal!: (expiresAt: number) => void;
    const renewalTransaction = new Promise<number>(resolve => {
      finishRenewal = resolve;
    });
    const doTn = vi.fn(() => renewalTransaction);
    Object.defineProperty(sweeper as any, "db", {
      get: () => ({ doTn }),
    });

    sweeper.start(100, logger);
    const detachedDone = sweeper.done;
    const oldGeneration = (sweeper as any).runGeneration as number;
    const oldClaim = {
      ks,
      phase: "delay",
      partition: 3,
      generation: "old-claim",
      expiresAt: 10_000,
      lifecycleGeneration: oldGeneration,
    };
    const renewal = (sweeper as any).renewClaim(oldClaim) as Promise<void>;
    expect(doTn).toHaveBeenCalledOnce();

    sweeper.forceStop();
    await detachedDone;
    sweeper.start(100, logger);
    const restartedDone = sweeper.done;
    observeDelay(sweeper, ks, (sweeper as any).runGeneration);

    finishRenewal(20_000);
    await expect(renewal).rejects.toThrow();
    expect(sweeper.getMetrics(10_001)).not.toContain('index="delay"');

    sweeper.stop();
    await restartedDone;
  });

  it("force-stops a generation and ignores its late state and metric mutations", async () => {
    const { ks, sweeper } = makeSweeper();
    const detachedPass = deferred();
    const restartedPass = deferred();
    let invocation = 0;
    vi.spyOn(sweeper, "sweepOnce").mockImplementation(
      async (_logger, _maxPartitions, lifecycleGeneration) => {
        invocation++;
        if (invocation === 1) {
          await detachedPass.promise;
          observeDelay(sweeper, ks, lifecycleGeneration);
          return;
        }
        await restartedPass.promise;
      },
    );

    sweeper.start(10, logger);
    const detachedDone = sweeper.done;
    const detachedSettled = vi.fn();
    void detachedDone.then(detachedSettled);
    await vi.advanceTimersByTimeAsync(10);
    expect((sweeper as any).running).toBe(true);

    sweeper.forceStop();
    sweeper.forceStop();
    await expect(detachedDone).resolves.toBeUndefined();
    expect(detachedSettled).toHaveBeenCalledOnce();
    expect(sweeper.isHealthy()).toBe(false);

    sweeper.start(10, logger);
    const restartedDone = sweeper.done;
    await vi.advanceTimersByTimeAsync(10);
    expect(invocation).toBe(2);
    expect((sweeper as any).running).toBe(true);
    expect(sweeper.isHealthy()).toBe(true);

    detachedPass.resolve();
    await flushPromises();
    expect((sweeper as any).running).toBe(true);
    expect(sweeper.isHealthy()).toBe(true);
    expect(sweeper.getMetrics(2_000)).not.toContain('index="delay"');
    expect(detachedSettled).toHaveBeenCalledOnce();

    sweeper.forceStop();
    await expect(restartedDone).resolves.toBeUndefined();
    restartedPass.resolve();
    await flushPromises();
    expect(sweeper.isHealthy()).toBe(false);
    expect(sweeper.getMetrics(2_000)).not.toContain('index="delay"');
  });
});
