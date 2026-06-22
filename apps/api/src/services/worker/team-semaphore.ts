import {
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { config } from "../../config";
import { isFdbTeam } from "./nuq-router";
import { externalSlotsFdb, nuqFdbHealthCheck, withFdbTimeout } from "./nuq-fdb";
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
    0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 15, 20, 30, 60, 120, 300,
  ],
});

const { scripts, runScript, ensure } = nuqRedis;

const SEMAPHORE_TTL = 30 * 1000;
const FDB_OPTIONAL_SLOT_TIMEOUT_MS = 500;
type MirrorBackend = "pg" | "fdb";
type MirrorState = { backend?: MirrorBackend; touched: Set<MirrorBackend> };

function fdbForced(): boolean {
  return config.NUQ_BACKEND === "fdb";
}

async function optionalFdbSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (fdbForced()) return operation();
  if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_SLOT_TIMEOUT_MS))) {
    throw new Error("FDB health check failed before optional slot operation");
  }
  return await withFdbTimeout(operation(), FDB_OPTIONAL_SLOT_TIMEOUT_MS);
}

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
      throw new ScrapeJobTimeoutError();
    }

    if (deadline < Date.now()) {
      throw new ScrapeJobTimeoutError();
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

function startHeartbeat(
  teamId: string,
  holderId: string,
  intervalMs: number,
  mirrorState: MirrorState,
) {
  let stopped = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  const promise = (async () => {
    try {
      while (!stopped) {
        await mirrorSlotAcquire(teamId, holderId, mirrorState).catch(() => {
          _logger.warn("Failed to update concurrency limit active job", {
            teamId,
            jobId: holderId,
          });
        });
        if (stopped) break;

        const ok = await heartbeat(teamId, holderId);
        if (!ok) {
          throw new TransportableError("SCRAPE_TIMEOUT", "heartbeat_failed");
        }
        if (stopped) break;
        await sleep(intervalMs);
      }
    } catch (error) {
      if (!stopped) {
        _logger.error("Error in semaphore heartbeat loop", { error });
      }
    }

    return Promise.reject(
      new Error("heartbeat loop stopped unexpectedly"),
    ) as never;
  })();

  return {
    promise,
    async stop() {
      stopped = true;
      wake?.();
      await promise.catch(() => {});
    },
  };
}

// Sync scrapes occupy queue capacity so async jobs see the team's real load.
// PG-backed teams mirror into the Redis ZSET; FDB-backed teams consume an
// external slot on the FDB ledger.
async function resolveMirrorBackend(teamId: string): Promise<MirrorBackend> {
  if (!(await isFdbTeam(teamId))) return "pg";
  if (fdbForced()) return "fdb";
  return (await nuqFdbHealthCheck(FDB_OPTIONAL_SLOT_TIMEOUT_MS)) ? "fdb" : "pg";
}

async function releaseMirrorBackend(
  teamId: string,
  holderId: string,
  backend: MirrorBackend,
): Promise<void> {
  if (backend === "fdb") {
    await optionalFdbSlot(() => externalSlotsFdb.release(teamId, holderId));
  } else {
    await removeConcurrencyLimitActiveJob(teamId, holderId);
  }
}

async function mirrorSlotAcquire(
  teamId: string,
  holderId: string,
  state: MirrorState,
): Promise<void> {
  const backend = await resolveMirrorBackend(teamId);
  if (backend === "fdb") {
    await optionalFdbSlot(() =>
      externalSlotsFdb.acquire(teamId, holderId, 60 * 1000),
    );
  } else {
    await pushConcurrencyLimitActiveJob(teamId, holderId, 60 * 1000);
  }
  const previous = state.backend;
  state.backend = backend;
  state.touched.add(backend);
  if (previous && previous !== backend) {
    await releaseMirrorBackend(teamId, holderId, previous);
    state.touched.delete(previous);
  }
}

async function mirrorSlotRelease(
  teamId: string,
  holderId: string,
  state: MirrorState,
): Promise<void> {
  const backends = Array.from(state.touched);
  const results = await Promise.allSettled(
    backends.map(backend => releaseMirrorBackend(teamId, holderId, backend)),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
  state.backend = undefined;
  state.touched.clear();
}

async function withSemaphore<T>(
  teamId: string,
  holderId: string,
  limit: number,
  signal: AbortSignal,
  timeoutMs: number,
  func: (limited: boolean) => Promise<T>,
): Promise<T> {
  // Bypass concurrency limits for self-hosted deployments
  if (isSelfHosted()) {
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
  const mirrorState: MirrorState = { touched: new Set() };
  let hb: ReturnType<typeof startHeartbeat> | null = null;

  activeSemaphores.inc();
  try {
    await mirrorSlotAcquire(teamId, holderId, mirrorState);
    hb = startHeartbeat(teamId, holderId, SEMAPHORE_TTL / 2, mirrorState);

    const result = await Promise.race([func(limited), hb.promise]);
    return result;
  } finally {
    await hb?.stop();

    await mirrorSlotRelease(teamId, holderId, mirrorState).catch(() => {
      _logger.warn("Failed to remove concurrency limit active job", {
        teamId,
        jobId: holderId,
      });
    });

    activeSemaphores.dec();
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
