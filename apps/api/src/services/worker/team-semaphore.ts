import {
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { isSelfHosted } from "../../lib/deployment";
import { ScrapeJobTimeoutError, TransportableError } from "../../lib/error";
import { logger as _logger } from "../../lib/logger";
import { nuqRedis, semaphoreKeys } from "./redis";
import { Gauge, Histogram, register } from "prom-client";

const activeSemaphores = new Gauge({
  name: "noq_semaphore_active",
  help: "Number of active semaphore holders",
});

const semaphoreAcquireDuration = new Histogram({
  name: "noq_semaphore_acquire_duration_seconds",
  help: "Semaphore acquire time",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const semaphoreHoldDuration = new Histogram({
  name: "noq_semaphore_hold_duration_seconds",
  help: "Semaphore hold time",
  buckets: [
    0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 240, 300, 600,
  ],
});

const { scripts, runScript, ensure } = nuqRedis;

const SEMAPHORE_TTL = 30 * 1000;

async function acquire(
  teamId: string,
  holderId: string,
  limit: number,
): Promise<{ granted: boolean; count: number; removed: number }> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const [granted, count, removed] = await runScript<[number, number, number]>(
    scripts.semaphore.acquire,
    [keys.leases],
    [holderId, limit, SEMAPHORE_TTL],
  );

  return {
    granted: granted === 1,
    count,
    removed,
  };
}

async function acquireBlocking(
  teamId: string,
  holderId: string,
  limit: number,
  options: {
    base_delay_ms: number;
    max_delay_ms: number;
    timeout_ms: number;
    signal: AbortSignal;
  },
): Promise<{ limited: boolean; removed: number }> {
  await ensure();

  const deadline = Date.now() + options.timeout_ms;
  const keys = semaphoreKeys(teamId);

  let delay = options.base_delay_ms;
  let totalRemoved = 0;
  let failedOnce = false;

  const endTimer = semaphoreAcquireDuration.startTimer();

  do {
    if (options.signal.aborted) {
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    if (deadline < Date.now()) {
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    const [granted, _count, _removed] = await runScript<
      [number, number, number]
    >(
      scripts.semaphore.acquire,
      [keys.leases],
      [holderId, limit, SEMAPHORE_TTL],
    );

    totalRemoved++;

    if (granted === 1) {
      endTimer();
      return { limited: failedOnce, removed: totalRemoved };
    }

    failedOnce = true;

    const jitter = Math.floor(
      Math.random() * Math.max(1, Math.floor(delay / 4)),
    );
    await new Promise(r => setTimeout(r, delay + jitter));

    delay = Math.min(options.max_delay_ms, Math.floor(delay * 1.5));
  } while (true);
}

async function heartbeat(teamId: string, holderId: string): Promise<boolean> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  return (
    (await runScript<number>(
      scripts.semaphore.heartbeat,
      [keys.leases],
      [holderId, SEMAPHORE_TTL],
    )) === 1
  );
}

async function release(teamId: string, holderId: string): Promise<void> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  await runScript<number>(scripts.semaphore.release, [keys.leases], [holderId]);
}

async function count(teamId: string): Promise<number> {
  await ensure();

  const keys = semaphoreKeys(teamId);
  const count = await nuqRedis.zcard(keys.leases);
  return count;
}

function startHeartbeat(teamId: string, holderId: string, intervalMs: number) {
  let stopped = false;

  const promise = (async () => {
    try {
      while (!stopped) {
        await pushConcurrencyLimitActiveJob(teamId, holderId, 60 * 1000).catch(
          () => {
            _logger.warn("Failed to update concurrency limit active job", {
              teamId,
              jobId: holderId,
            });
          },
        );

        const ok = await heartbeat(teamId, holderId);
        if (!ok) {
          throw new TransportableError("SCRAPE_TIMEOUT", "heartbeat_failed");
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    } catch (error) {
      _logger.error("Error in semaphore heartbeat loop", { error });
    }

    return Promise.reject(
      new Error("heartbeat loop stopped unexpectedly"),
    ) as never;
  })();

  return {
    promise,
    stop() {
      stopped = true;
    },
  };
}

async function withSemaphore<T>(
  teamId: string,
  holderId: string,
  limit: number,
  signal: AbortSignal,
  timeoutMs: number,
  func: (limited: boolean) => Promise<T>,
): Promise<T> {
  if (isSelfHosted() && limit <= 1) {
    _logger.debug(`Bypassing concurrency limit for ${teamId}`, {
      teamId,
      jobId: holderId,
    });
    return await func(false);
  }

  const { limited } = await acquireBlocking(teamId, holderId, limit, {
    base_delay_ms: 25,
    max_delay_ms: 250,
    timeout_ms: timeoutMs,
    signal,
  });

  const endTimer = semaphoreHoldDuration.startTimer();
  const hb = startHeartbeat(teamId, holderId, SEMAPHORE_TTL / 2);

  activeSemaphores.inc();
  try {
    await pushConcurrencyLimitActiveJob(teamId, holderId, 60 * 1000);

    const result = await Promise.race([func(limited), hb.promise]);
    return result;
  } finally {
    await removeConcurrencyLimitActiveJob(teamId, holderId).catch(() => {
      _logger.warn("Failed to remove concurrency limit active job", {
        teamId,
        jobId: holderId,
      });
    });

    activeSemaphores.dec();
    hb.stop();
    endTimer();

    await release(teamId, holderId).catch(() => {});
  }
}

const getMetrics = async () => {
  return register.metrics();
};

export const teamConcurrencySemaphore = {
  acquire,
  release,
  withSemaphore,
  count,
  getMetrics,
};
