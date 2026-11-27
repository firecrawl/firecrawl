import type { Logger } from "winston";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import type { Document } from "../../controllers/v2/types";
import type { ScrapeJobData } from "../../types";
import { redisEvictConnection } from "../../services/redis";
import { crawlStateStore } from "../../lib/crawl-state-store";
import { getRedisConnection } from "../../services/queue-service";
import { currentLimits } from "../../lib/limits";
import { jobContext, requestContext } from "../../lib/request-context";
import { safeParseLogged } from "../../lib/zod-log";
import type { RequestContext } from "../../service/request-context";
import {
  getTeamQueueLimit,
  getConcurrencyLimitActiveJobsCount,
  removeConcurrencyLimitActiveJob,
  reserveConcurrencyLimitSlot,
} from "../../lib/concurrency-redis";
import type {
  NuQJob,
  NuQJobStatus,
  NuQGroupStatus,
  NuQJobGroupInstance,
} from "./nuq";
import {
  scrapeQueue as scrapeQueuePg,
  crawlFinishedQueue as crawlFinishedQueuePg,
  crawlGroup as crawlGroupPg,
} from "./nuq";
import type { NuQFdbJob } from "./nuq-fdb";
import {
  scrapeQueueFdb,
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotsFdb,
  isFdbConfigured,
  nuqFdbHealthCheck,
  withFdbTimeout,
} from "./nuq-fdb";

// Dual-backend router for the NuQ migration to FoundationDB. Exports the same
// `scrapeQueue` / `crawlFinishedQueue` / `crawlGroup` names as ./nuq so call
// sites only swap their import path. Routing rules:
//  - new crawls: team flag (TeamFlags.nuqFdb) or NUQ_BACKEND=fdb decides; the
//    choice is pinned in StoredCrawl.queueBackend so a crawl never spans
//    backends
//  - reads: stored crawl/job backend markers decide the backend; unmarked jobs
//    default to PG so FDB outages do not affect non-FDB traffic
//  - workers: production workers consume PG and FDB via separate entrypoints;
//    this class still tracks in-flight backend for direct/router test consumers

export type QueueBackend = "pg" | "fdb";

export type { NuQJob, NuQJobStatus, NuQGroupStatus, NuQJobGroupInstance };

export function fdbQueueEnabled(): boolean {
  return isFdbConfigured();
}

function fdbForced(): boolean {
  return config.NUQ_BACKEND === "fdb";
}

const fdbFallbackLastWarn = new Map<string, number>();
const FDB_OPTIONAL_OP_TIMEOUT_MS = 500;

function logFdbFallback(
  logger: Logger,
  operation: string,
  error: unknown,
): void {
  const now = Date.now();
  const lastWarn = fdbFallbackLastWarn.get(operation) ?? 0;
  if (now - lastWarn < 60_000) {
    return;
  }
  fdbFallbackLastWarn.set(operation, now);
  logger.warn("FDB queue operation failed, falling back to PG", {
    module: "nuq-router",
    operation,
    error,
  });
}

async function optionalFdb<T>(operation: () => Promise<T>): Promise<T> {
  if (fdbForced()) {
    return operation();
  }
  if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_OP_TIMEOUT_MS))) {
    throw new Error("FDB health check failed before optional operation");
  }
  return await withFdbTimeout(operation(), FDB_OPTIONAL_OP_TIMEOUT_MS);
}

// Whether NEW work for this team should go to FDB. Existing crawls follow
// their StoredCrawl.queueBackend marker instead. Request-scoped callers pass
// `ctx`; omitting `ctx` leaves `flags` undefined so background team-ID-only
// paths let `LimitsModule.queueBackend` resolve by `ctx.teamId`.
export async function isFdbTeam(
  teamId: string | undefined,
  ctx?: RequestContext,
): Promise<boolean> {
  if (!fdbQueueEnabled()) {
    return false;
  }
  if (fdbForced()) {
    return true;
  }
  if (!teamId) {
    return false;
  }
  try {
    const resolvedCtx =
      ctx ??
      requestContext({
        teamId,
        zeroDataRetention: false,
      });
    return (await currentLimits().queueBackend(resolvedCtx)) === "fdb";
  } catch (error: unknown) {
    _logger.warn("Failed to resolve queue backend override, defaulting to pg", {
      module: "nuq-router",
      teamId,
      error,
    });
    return false;
  }
}

export async function resolveNewGroupBackend(
  teamId: string,
  ctx?: RequestContext,
): Promise<QueueBackend> {
  return (await isFdbTeam(teamId, ctx)) ? "fdb" : "pg";
}

const crawlQueueBackendSchema = z.object({
  queueBackend: z.unknown().optional(),
});

// Reads only the queueBackend marker off the stored crawl. Deliberately not
// getCrawl() -- importing crawl-redis pulls the whole scraper tree in.
async function getCrawlQueueBackend(
  crawlId: string,
): Promise<QueueBackend | null> {
  if (fdbForced()) {
    return "fdb";
  }
  const raw = await (await crawlStateStore(crawlId)).get("crawl:" + crawlId);
  if (!raw) {
    return null;
  }
  try {
    const parsed = safeParseLogged(
      crawlQueueBackendSchema,
      JSON.parse(raw),
      "nuq-router.crawlQueueBackend",
    );
    return parsed.success
      ? parsed.data.queueBackend === "fdb"
        ? "fdb"
        : "pg"
      : null;
  } catch {
    return null;
  }
}

async function resolveGroupBackend(
  groupId: string,
  logger: Logger = _logger,
): Promise<QueueBackend> {
  const backend = await getCrawlQueueBackend(groupId);
  if (backend) {
    return backend;
  }
  if (!fdbQueueEnabled()) {
    return "pg";
  }

  try {
    const group = await optionalFdb(() =>
      crawlGroupFdb.getGroup(groupId, logger),
    );
    return group ? "fdb" : "pg";
  } catch (error) {
    if (fdbForced()) {
      throw error;
    }
    logFdbFallback(logger, "resolveGroupBackend", error);
    return "pg";
  }
}

const jobBackendKey = (jobId: string) => `nuq:job_backend:${jobId}`;

async function markJobBackend(
  jobId: string,
  backend: QueueBackend,
): Promise<void> {
  if (fdbForced()) {
    return;
  }
  await redisEvictConnection.set(
    jobBackendKey(jobId),
    backend,
    "EX",
    24 * 60 * 60,
  );
}

async function getJobQueueBackend(jobId: string): Promise<QueueBackend> {
  if (fdbForced()) {
    return "fdb";
  }
  return (await redisEvictConnection.get(jobBackendKey(jobId))) === "fdb"
    ? "fdb"
    : "pg";
}

// Which backend a job belongs to at enqueue time. Crawl jobs follow their
// crawl's pinned backend; standalone jobs follow the limits module override.
export async function resolveJobBackend(
  data: ScrapeJobData,
): Promise<QueueBackend> {
  if (!fdbQueueEnabled()) {
    return "pg";
  }
  if (fdbForced()) {
    return "fdb";
  }
  if (data.crawl_id) {
    return (await getCrawlQueueBackend(data.crawl_id)) ?? "pg";
  }
  return (await isFdbTeam(data.team_id, jobContext(data))) ? "fdb" : "pg";
}

function tagFdbJob<T extends NuQJob<unknown, unknown>>(
  job: T,
): T & { backend: "fdb" } {
  return Object.assign(job, { backend: "fdb" as const });
}

// === External capacity holders (browser sessions, sync scrapes)
//
// Non-queue work that occupies team capacity mirrors itself into whichever
// ledger the team runs on. When FDB is selected dynamically, record the holder's
// backend so context-free settlement releases the same ledger; Redis entries
// expire by score and FDB external slots are reaped by the sweeper as a backstop.

const externalSlotBackendKey = (holderId: string) =>
  `nuq:external_slot_backend:${holderId}`;

async function markExternalSlotBackend(
  holderId: string,
  backend: QueueBackend,
  ttlMs: number,
): Promise<void> {
  if (fdbForced()) {
    return;
  }
  try {
    await getRedisConnection().set(
      externalSlotBackendKey(holderId),
      backend,
      "PX",
      Math.max(ttlMs, 0) + 60_000,
    );
  } catch (error: unknown) {
    _logger.warn("Failed to record external slot backend marker", {
      module: "nuq-router",
      holderId,
      backend,
      error,
    });
    throw error;
  }
}

async function getExternalSlotBackend(
  holderId: string,
): Promise<QueueBackend | null> {
  if (!fdbQueueEnabled() || fdbForced()) {
    return null;
  }
  try {
    const raw = await getRedisConnection().get(
      externalSlotBackendKey(holderId),
    );
    return raw === "fdb" ? "fdb" : null;
  } catch (error: unknown) {
    _logger.warn("Failed to read external slot backend marker", {
      module: "nuq-router",
      holderId,
      error,
    });
    return null;
  }
}

async function clearExternalSlotBackend(holderId: string): Promise<void> {
  if (!fdbQueueEnabled() || fdbForced()) {
    return;
  }
  try {
    await getRedisConnection().del(externalSlotBackendKey(holderId));
  } catch (error: unknown) {
    _logger.warn("Failed to clear external slot backend marker", {
      module: "nuq-router",
      holderId,
      error,
    });
  }
}

export async function reserveExternalSlot(
  teamId: string,
  holderId: string,
  ttlMs: number,
  limit: number,
  ctx?: RequestContext,
): Promise<boolean> {
  if (await isFdbTeam(teamId, ctx)) {
    const legacyActive = await getConcurrencyLimitActiveJobsCount(teamId);
    // Record before acquiring so a timed-out write that committed remotely
    // still routes later context-free settlement releases to FDB.
    await markExternalSlotBackend(holderId, "fdb", ttlMs);
    const acquired = await optionalFdb(() =>
      externalSlotsFdb.acquire(teamId, holderId, ttlMs, limit - legacyActive),
    );
    if (!acquired) {
      await clearExternalSlotBackend(holderId);
    }
    return acquired;
  }
  const acquired = await reserveConcurrencyLimitSlot(
    teamId,
    holderId,
    ttlMs,
    limit,
  );
  if (acquired) {
    await clearExternalSlotBackend(holderId);
  }
  return acquired;
}

export async function mirrorExternalSlotRelease(
  teamId: string,
  holderId: string,
  ctx?: RequestContext,
): Promise<void> {
  const recordedFdb = (await getExternalSlotBackend(holderId)) === "fdb";
  if (recordedFdb || (await isFdbTeam(teamId, ctx))) {
    try {
      await optionalFdb(() => externalSlotsFdb.release(teamId, holderId));
      if (recordedFdb) {
        await clearExternalSlotBackend(holderId);
      }
      return;
    } catch (error) {
      if (fdbForced()) {
        throw error;
      }
      logFdbFallback(_logger, "mirrorExternalSlotRelease", error);
    }
  }
  await removeConcurrencyLimitActiveJob(teamId, holderId);
}

// Active count across both ledgers; a migrating team has load on both while
// its old PG crawls drain.
export async function getCombinedTeamActiveCount(
  teamId: string,
  ctx?: RequestContext,
): Promise<number> {
  const redisCount = await getConcurrencyLimitActiveJobsCount(teamId);
  if (!(await isFdbTeam(teamId, ctx))) {
    return redisCount;
  }
  try {
    return (
      redisCount +
      (await optionalFdb(() => scrapeQueueFdb.getTeamActiveCount(teamId)))
    );
  } catch (error) {
    if (fdbForced()) {
      throw error;
    }
    logFdbFallback(_logger, "getCombinedTeamActiveCount", error);
    return redisCount;
  }
}

// === FDB enqueue (the whole gating block of queue-jobs collapses into this)

export function backlogTimeoutMsForGate(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

export async function fdbEnqueueScrapeJobs(
  jobs: Array<{
    jobId: string;
    data: ScrapeJobData;
    priority: number;
    listenable?: boolean;
    backlogTimeoutMs: number;
  }>,
  teamId: string,
  options?: { bypassGate?: boolean },
): Promise<{
  jobs: Array<
    NuQJob<ScrapeJobData, Document | null> & {
      backend: "fdb";
      backlogLimit?: number;
    }
  >;
  backloggedCount: number;
  teamLimit: number | null;
  backlogLimit: number | null;
}> {
  const limits = currentLimits();
  const firstCtx = jobs.length > 0 ? jobContext(jobs[0].data) : null;
  const liveFirstCtx =
    firstCtx && firstCtx.concurrencyLimit !== undefined
      ? { ...firstCtx, concurrencyLimit: undefined }
      : firstCtx;
  const teamLimit =
    liveFirstCtx && liveFirstCtx.teamId === teamId
      ? await limits.concurrency(liveFirstCtx)
      : await limits.teamConcurrency(teamId);

  const queueCap =
    teamLimit === null ? Number.MAX_SAFE_INTEGER : getTeamQueueLimit(teamLimit);

  // Per-key concurrency applies when every job in the batch shares the same
  // API key and the active limits module enforces a cap for that key.
  let keyGate: { id: string; limit: number } | null = null;
  if (teamLimit !== null && limits.keyConcurrency && firstCtx) {
    const keyIds = new Set(jobs.map(j => jobContext(j.data).apiKeyId ?? null));
    const apiKeyId = keyIds.size === 1 ? [...keyIds][0] : null;
    if (apiKeyId !== null) {
      keyGate = await limits
        .keyConcurrency(firstCtx)
        .catch((error: unknown) => {
          _logger.warn("Failed to resolve API key concurrency limit", {
            module: "nuq-router",
            teamId,
            apiKeyId,
            error,
          });
          return null;
        });
    }
  }

  const results = await optionalFdb(() =>
    scrapeQueueFdb.addJobs(
      jobs.map(j => ({
        id: j.jobId,
        data: j.data,
        options: {
          priority: j.priority,
          listenable: j.listenable ?? false,
          ownerId: j.data.team_id ?? undefined,
          groupId: j.data.crawl_id ?? undefined,
          bypassGate:
            options?.bypassGate ||
            j.data.mode === "kickoff" ||
            j.data.mode === "kickoff_sitemap",
          timesOutAt: new Date(Date.now() + j.backlogTimeoutMs),
        },
      })),
      { teamLimit, queueCap, key: keyGate },
    ),
  );

  const tagged = results.map(r => tagFdbJob(r));
  const markerResults = await Promise.allSettled(
    tagged.map(job => markJobBackend(job.id, "fdb")),
  );
  const markerFailures = markerResults.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (markerFailures.length > 0) {
    _logger.warn("Failed to mark some FDB job backends", {
      module: "nuq-router",
      failed: markerFailures.length,
      total: markerResults.length,
      errors: markerFailures.map(r =>
        r.reason instanceof Error ? r.reason : String(r.reason),
      ),
    });
  }
  const backloggedJobs = tagged.filter(j => j.status === "backlog");
  return {
    jobs: tagged,
    backloggedCount: backloggedJobs.length,
    teamLimit,
    backlogLimit: backloggedJobs[0]?.backlogLimit ?? null,
  };
}

// === Routed scrape queue

class RoutedScrapeQueue {
  // in-flight jobs taken by THIS process, so renew/finish/fail can route
  private inflightBackend = new Map<string, QueueBackend>();

  private backendFor(id: string): QueueBackend {
    return this.inflightBackend.get(id) ?? "pg";
  }

  public async getJobToProcess(
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData, Document | null> | null> {
    if (fdbQueueEnabled()) {
      try {
        const job = await optionalFdb(() =>
          scrapeQueueFdb.getJobToProcess(logger),
        );
        if (job) {
          this.inflightBackend.set(job.id, "fdb");
          return tagFdbJob(job);
        }
      } catch (error: unknown) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "scrape.getJobToProcess", error);
      }
    }
    const job = await scrapeQueuePg.getJobToProcess();
    if (job) {
      this.inflightBackend.set(job.id, "pg");
    }
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    if (this.backendFor(id) === "fdb") {
      try {
        return await optionalFdb(() =>
          scrapeQueueFdb.renewLock(id, lock, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "scrape.renewLock", error);
        return false;
      }
    }
    return scrapeQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: unknown,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    this.inflightBackend.delete(id);
    if (backend === "fdb") {
      try {
        return await optionalFdb(() =>
          scrapeQueueFdb.jobFinish(id, lock, returnvalue, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "scrape.jobFinish", error);
        return false;
      }
    }
    return scrapeQueuePg.jobFinish(id, lock, returnvalue, logger);
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    this.inflightBackend.delete(id);
    if (backend === "fdb") {
      try {
        return await optionalFdb(() =>
          scrapeQueueFdb.jobFail(id, lock, failedReason, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "scrape.jobFail", error);
        return false;
      }
    }
    return scrapeQueuePg.jobFail(id, lock, failedReason, logger);
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData | null, Document | null> | null> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      const job = await optionalFdb(() => scrapeQueueFdb.getJob(id, logger));
      return job ? tagFdbJob(job) : null;
    }
    return scrapeQueuePg.getJob(id, logger);
  }

  public async getJobs(
    ids: Array<string>,
    logger: Logger = _logger,
  ): Promise<Array<NuQJob<ScrapeJobData | null, Document | null>>> {
    if (ids.length === 0) {
      return [];
    }
    const backends = await Promise.all(ids.map(id => getJobQueueBackend(id)));
    const fdbIds = ids.filter((_, i) => backends[i] === "fdb");
    const pgIds = ids.filter((_, i) => backends[i] === "pg");
    const [fdbJobs, pgJobs] = await Promise.all([
      fdbIds.length > 0
        ? optionalFdb(() => scrapeQueueFdb.getJobs(fdbIds, logger))
        : Promise.resolve<
            Array<NuQFdbJob<ScrapeJobData | null, Document | null>>
          >([]),
      pgIds.length > 0
        ? scrapeQueuePg.getJobs(pgIds, logger)
        : Promise.resolve<Array<NuQJob<ScrapeJobData, Document | null>>>([]),
    ]);
    const byId = new Map<
      string,
      NuQJob<ScrapeJobData | null, Document | null>
    >();
    for (const j of fdbJobs) {
      byId.set(j.id, tagFdbJob(j));
    }
    for (const j of pgJobs) {
      byId.set(j.id, j);
    }
    const ordered: Array<NuQJob<ScrapeJobData | null, Document | null>> = [];
    for (const id of ids) {
      const job = byId.get(id);
      if (job !== undefined) {
        ordered.push(job);
      }
    }
    return ordered;
  }

  public async getJobsWithStatus(
    ids: Array<string>,
    status: NuQJobStatus,
    logger: Logger = _logger,
  ): Promise<Array<NuQJob<ScrapeJobData | null, Document | null>>> {
    return (await this.getJobs(ids, logger)).filter(j => j.status === status);
  }

  public async getJobsWithStatuses(
    ids: Array<string>,
    statuses: Array<NuQJobStatus>,
    logger: Logger = _logger,
  ): Promise<Array<NuQJob<ScrapeJobData | null, Document | null>>> {
    const set = new Set(statuses);
    return (await this.getJobs(ids, logger)).filter(j => set.has(j.status));
  }

  public async getGroupAnyJob(
    groupId: string,
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData | null, Document | null> | null> {
    if ((await resolveGroupBackend(groupId, logger)) === "fdb") {
      const job = await optionalFdb(() =>
        scrapeQueueFdb.getGroupAnyJob(groupId, ownerId, logger),
      );
      return job ? tagFdbJob(job) : null;
    }
    return scrapeQueuePg.getGroupAnyJob(groupId, ownerId);
  }

  public async getGroupNumericStats(
    groupId: string,
    logger: Logger = _logger,
  ): Promise<Record<NuQJobStatus, number>> {
    if ((await resolveGroupBackend(groupId, logger)) === "fdb") {
      return await optionalFdb(() =>
        scrapeQueueFdb.getGroupNumericStats(groupId, logger),
      );
    }
    return scrapeQueuePg.getGroupNumericStats(groupId, logger);
  }

  public async getGroupJobs(
    groupId: string,
    status: "completed" | "failed",
    limit?: number,
    offset = 0,
    logger: Logger = _logger,
  ): Promise<Array<NuQJob<ScrapeJobData | null, Document | null>>> {
    if ((await resolveGroupBackend(groupId, logger)) === "fdb") {
      const jobs = await optionalFdb(() =>
        scrapeQueueFdb.getGroupJobs(groupId, status, limit, offset, logger),
      );
      return jobs.map(j => tagFdbJob(j));
    }
    return scrapeQueuePg.getGroupJobs(groupId, status, limit, offset, logger);
  }

  public async removeJob(id: string, logger: Logger = _logger): Promise<void> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      await optionalFdb(() => scrapeQueueFdb.removeJob(id, logger));
      return;
    }
    await scrapeQueuePg.removeJob(id, logger);
  }

  public async removeJobs(
    ids: Array<string>,
    logger: Logger = _logger,
  ): Promise<void> {
    for (const id of ids) {
      await this.removeJob(id, logger);
    }
  }

  public async waitForJob<_T = Document | null>(
    id: string,
    timeout: number | null,
    logger: Logger = _logger,
  ): Promise<Document | null> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      // Waiting is intentionally long-lived; callers pass the real scrape
      // timeout. optionalFdb is only for quick FDB reads/writes and applies a
      // 500ms guard, which would incorrectly fail synchronous FDB-backed jobs.
      return scrapeQueueFdb.waitForJob(id, timeout, logger);
    }
    return scrapeQueuePg.waitForJob(id, timeout, logger);
  }

  public async getMetrics(logger: Logger = _logger) {
    return scrapeQueuePg.getMetrics();
  }
}

// === Routed crawl-finished queue (worker consumer + reads)

class RoutedCrawlFinishedQueue {
  private inflightBackend = new Map<string, QueueBackend>();

  public async getJobToProcess(
    logger: Logger = _logger,
  ): Promise<NuQJob | null> {
    if (fdbQueueEnabled()) {
      try {
        const job = await optionalFdb(() =>
          crawlFinishedQueueFdb.getJobToProcess(logger),
        );
        if (job) {
          this.inflightBackend.set(job.id, "fdb");
          return tagFdbJob(job);
        }
      } catch (error: unknown) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "crawlFinished.getJobToProcess", error);
      }
    }
    const job = await crawlFinishedQueuePg.getJobToProcess();
    if (job) {
      this.inflightBackend.set(job.id, "pg");
    }
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    if (this.inflightBackend.get(id) === "fdb") {
      try {
        return await optionalFdb(() =>
          crawlFinishedQueueFdb.renewLock(id, lock, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "crawlFinished.renewLock", error);
        return false;
      }
    }
    return crawlFinishedQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: unknown,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    this.inflightBackend.delete(id);
    if (backend === "fdb") {
      try {
        return await optionalFdb(() =>
          crawlFinishedQueueFdb.jobFinish(id, lock, returnvalue, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "crawlFinished.jobFinish", error);
        return false;
      }
    }
    return crawlFinishedQueuePg.jobFinish(id, lock, returnvalue, logger);
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    this.inflightBackend.delete(id);
    if (backend === "fdb") {
      try {
        return await optionalFdb(() =>
          crawlFinishedQueueFdb.jobFail(id, lock, failedReason, logger),
        );
      } catch (error) {
        if (fdbForced()) {
          throw error;
        }
        logFdbFallback(logger, "crawlFinished.jobFail", error);
        return false;
      }
    }
    return crawlFinishedQueuePg.jobFail(id, lock, failedReason, logger);
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob | null> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      const job = await optionalFdb(() =>
        crawlFinishedQueueFdb.getJob(id, logger),
      );
      return job ? tagFdbJob(job) : null;
    }
    return crawlFinishedQueuePg.getJob(id, logger);
  }
}

// === Routed crawl group

class RoutedCrawlGroup {
  public async addGroup(
    id: string,
    ownerId: string,
    ttl?: number,
    opts?: {
      backend?: QueueBackend;
      maxConcurrency?: number;
      delaySeconds?: number;
    },
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance> {
    if (opts?.backend === "fdb") {
      const g = await optionalFdb(() =>
        crawlGroupFdb.addGroup(
          id,
          ownerId,
          ttl,
          {
            maxConcurrency: opts.maxConcurrency,
            delaySeconds: opts.delaySeconds,
          },
          logger,
        ),
      );
      return g;
    }
    return crawlGroupPg.addGroup(id, ownerId, ttl, logger);
  }

  public async getGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance | null> {
    if ((await resolveGroupBackend(id, logger)) === "fdb") {
      return await optionalFdb(() => crawlGroupFdb.getGroup(id, logger));
    }
    return crawlGroupPg.getGroup(id, logger);
  }

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
    ctx?: RequestContext,
  ): Promise<Array<NuQJobGroupInstance>> {
    if (!(await isFdbTeam(ownerId, ctx))) {
      return crawlGroupPg.getOngoingByOwner(ownerId, logger);
    }
    let fdb: Array<NuQJobGroupInstance>;
    try {
      fdb = await optionalFdb(() =>
        crawlGroupFdb.getOngoingByOwner(ownerId, logger),
      );
    } catch (error) {
      if (fdbForced()) {
        throw error;
      }
      logFdbFallback(logger, "crawlGroup.getOngoingByOwner", error);
      return crawlGroupPg.getOngoingByOwner(ownerId, logger);
    }
    if (fdbForced()) {
      return fdb;
    }
    const pg = await crawlGroupPg.getOngoingByOwner(ownerId, logger);
    const seen = new Set(fdb.map(g => g.id));
    return [...fdb, ...pg.filter(g => !seen.has(g.id))];
  }

  // O(1) cancel; only meaningful for FDB groups. PG crawls keep their
  // existing Redis-based cancellation path.
  public async cancelGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    if ((await resolveGroupBackend(id, logger)) !== "fdb") {
      return false;
    }
    try {
      return await optionalFdb(() => crawlGroupFdb.cancelGroup(id, logger));
    } catch (error) {
      if (fdbForced()) {
        throw error;
      }
      logFdbFallback(logger, "crawlGroup.cancelGroup", error);
      return false;
    }
  }
}

export const scrapeQueue = new RoutedScrapeQueue();
export const crawlFinishedQueue = new RoutedCrawlFinishedQueue();
export const crawlGroup = new RoutedCrawlGroup();
