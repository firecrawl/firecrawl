import type { NuQJob } from "./nuq";

export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type RequiredWorkerLoop = {
  name: string;
  isHealthy: () => boolean;
  done: Promise<void>;
};

export function superviseRequiredWorkerLoops(
  requiredLoops: readonly RequiredWorkerLoop[],
  isShuttingDown: () => boolean,
  onFatal: (loopName: string, error: unknown) => void,
): void {
  for (const requiredLoop of requiredLoops) {
    void requiredLoop.done.then(
      () => {
        if (isShuttingDown()) return;
        onFatal(
          requiredLoop.name,
          new Error(`Required loop ${requiredLoop.name} stopped unexpectedly`),
        );
      },
      error => {
        if (isShuttingDown()) return;
        onFatal(requiredLoop.name, error);
      },
    );
  }
}

export type QueueOperationOptions = { timeoutMs: number };

export type LeasedJobQueue = {
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

export type FenceReason =
  | "lock-lost"
  | "renewal-failed"
  | "finalization-timeout"
  | "shutdown";

export type LeasedJobResult =
  | { status: "completed" }
  | { status: "failed" }
  | { status: "fenced"; reason: FenceReason }
  | { status: "finalization-failed"; error: unknown };

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000];

export function waitForAbortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, Math.max(0, delayMs));
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function nextIdlePollDelay(
  previousBaseMs: number,
  options: {
    minMs?: number;
    maxMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): { delayMs: number; nextBaseMs: number } {
  const minMs = options.minMs ?? 500;
  const maxMs = options.maxMs ?? 10_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const base = Math.max(minMs, Math.min(maxMs, previousBaseMs));
  const jitter = (random() * 2 - 1) * jitterRatio;
  return {
    delayMs: Math.min(maxMs, Math.max(0, Math.round(base * (1 + jitter)))),
    nextBaseMs: Math.min(maxMs, base * 2),
  };
}

export async function retryWithBackoff<T>(options: {
  operation: (attempt: number) => Promise<T>;
  attempts?: number;
  delaysMs?: number[];
  signal?: AbortSignal;
  shouldRetry?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("operation aborted");
    }
    try {
      return await options.operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || options.shouldRetry?.(error) === false) break;
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.onRetry?.(error, attempt, delayMs);
      await waitForAbortableDelay(delayMs, options.signal);
    }
  }
  throw lastError;
}

class OperationTimeoutError extends Error {}

export async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new OperationTimeoutError(
                `${label} timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function settleDrain(
  tasks: Promise<unknown>[],
  onError: (error: unknown) => void,
): Promise<boolean> {
  try {
    await Promise.all(tasks);
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

function failureReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Runs a job while owning its lease. Renewals never overlap each other, and
 * stop() waits for an in-flight renewal before finalization can begin.
 */
export async function runLeasedJob<T>(options: {
  queue: LeasedJobQueue;
  job: NuQJob<any, any>;
  process: (signal: AbortSignal) => Promise<T>;
  logger: RuntimeLogger;
  shutdownSignal?: AbortSignal;
  renewIntervalMs?: number;
  renewalAttempts?: number;
  renewalRetryDelaysMs?: number[];
  renewalTimeoutMs?: number;
  finalizationAttempts?: number;
  finalizationRetryDelaysMs?: number[];
  finalizationTimeoutMs?: number;
  onFence?: (reason: FenceReason) => void;
}): Promise<LeasedJobResult> {
  const lock = options.job.lock;
  if (!lock) throw new Error(`Job ${options.job.id} has no lock`);

  const controller = new AbortController();
  let fenceReason: FenceReason | null = null;
  let renewTimer: NodeJS.Timeout | undefined;
  let inFlightRenewal: Promise<void> | null = null;
  let renewing = true;

  const fence = (reason: FenceReason) => {
    if (fenceReason !== null) return;
    fenceReason = reason;
    controller.abort(new Error(`Job fenced: ${reason}`));
    options.onFence?.(reason);
  };
  const onShutdown = () => fence("shutdown");
  options.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  if (options.shutdownSignal?.aborted) onShutdown();

  const scheduleRenewal = () => {
    if (!renewing || controller.signal.aborted) return;
    renewTimer = setTimeout(() => {
      inFlightRenewal = renew().finally(() => {
        inFlightRenewal = null;
        scheduleRenewal();
      });
    }, options.renewIntervalMs ?? 15_000);
  };

  const renew = async () => {
    try {
      const renewed = await retryWithBackoff({
        attempts: options.renewalAttempts ?? 3,
        delaysMs: options.renewalRetryDelaysMs,
        signal: controller.signal,
        shouldRetry: error => !(error instanceof OperationTimeoutError),
        operation: async attempt => {
          options.logger.info?.("Renewing job lock", { attempt });
          return await withOperationTimeout(
            options.queue.renewLock(options.job.id, lock, options.logger, {
              timeoutMs: options.renewalTimeoutMs ?? 5_000,
            }),
            options.renewalTimeoutMs ?? 5_000,
            "job lock renewal",
          );
        },
        onRetry: (error, attempt, delayMs) => {
          options.logger.warn("Job lock renewal failed transiently", {
            error,
            attempt,
            delayMs,
          });
        },
      });
      if (!renewed) {
        options.logger.warn("Job lock was lost");
        fence("lock-lost");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      options.logger.error("Job lock renewal retries exhausted", { error });
      fence("renewal-failed");
    }
  };

  const stopRenewals = async () => {
    renewing = false;
    if (renewTimer) clearTimeout(renewTimer);
    await inFlightRenewal;
  };

  if (fenceReason !== null) {
    options.shutdownSignal?.removeEventListener("abort", onShutdown);
    return { status: "fenced", reason: fenceReason };
  }

  scheduleRenewal();

  let processResult: { ok: true; data: T } | { ok: false; error: unknown };
  try {
    processResult = {
      ok: true,
      data: await options.process(controller.signal),
    };
  } catch (error) {
    processResult = { ok: false, error };
  }

  await stopRenewals();
  options.shutdownSignal?.removeEventListener("abort", onShutdown);

  if (fenceReason !== null) {
    return { status: "fenced", reason: fenceReason };
  }

  try {
    const finalized = await retryWithBackoff({
      attempts: options.finalizationAttempts ?? 3,
      delaysMs: options.finalizationRetryDelaysMs,
      shouldRetry: error => !(error instanceof OperationTimeoutError),
      operation: async attempt => {
        const finalization = processResult.ok
          ? options.queue.jobFinish(
              options.job.id,
              lock,
              processResult.data,
              options.logger,
              { timeoutMs: options.finalizationTimeoutMs ?? 10_000 },
            )
          : options.queue.jobFail(
              options.job.id,
              lock,
              failureReason(processResult.error),
              options.logger,
              { timeoutMs: options.finalizationTimeoutMs ?? 10_000 },
            );
        const result = await withOperationTimeout(
          finalization,
          options.finalizationTimeoutMs ?? 10_000,
          "job finalization",
        );
        if (!result) fence("lock-lost");
        options.logger.debug?.("Finalized job", { attempt, result });
        return result;
      },
      onRetry: (error, attempt, delayMs) => {
        options.logger.warn("Job finalization failed transiently", {
          error,
          attempt,
          delayMs,
        });
      },
    });
    if (!finalized || fenceReason !== null) {
      return { status: "fenced", reason: "lock-lost" };
    }
    return { status: processResult.ok ? "completed" : "failed" };
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      options.logger.error("Job finalization timed out; fencing worker", {
        error,
      });
      fence("finalization-timeout");
      return { status: "fenced", reason: "finalization-timeout" };
    }
    options.logger.error("Job finalization retries exhausted", { error });
    return { status: "finalization-failed", error };
  }
}
