import { Logger } from "winston";
import { logger as _logger } from "../../lib/logger";
import { config } from "../../config";
import { RateLimiterMode, ScrapeJobData } from "../../types";
import { getACUCTeam } from "../../controllers/auth";
import { redisEvictConnection } from "../../services/redis";
import { isSelfHosted } from "../../lib/deployment";
import { getApiKeyConcurrencyLimit } from "../../lib/api-key-concurrency";
import { redlock } from "../redlock";
import { getRedisConnection } from "../queue-service";
import {
  getTeamQueueLimit,
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-redis";
import {
  NuQJob,
  NuQJobStatus,
  NuQGroupStatus,
  NuQJobGroupInstance,
  scrapeQueue as scrapeQueuePg,
  crawlFinishedQueue as crawlFinishedQueuePg,
  crawlGroup as crawlGroupPg,
} from "./nuq";
import {
  scrapeQueueFdb,
  crawlFinishedQueueFdb,
  crawlGroupFdb,
  externalSlotsFdb,
  isFdbConfigured,
  nuqFdbHealthCheck,
  withFdbTimeout,
  NuQFdbQueue,
  NuQFdbJob,
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

const FDB_OPTIONAL_OP_TIMEOUT_MS = 500;

async function optionalFdbRead<T>(operation: () => Promise<T>): Promise<T> {
  if (fdbForced()) return operation();
  if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_OP_TIMEOUT_MS))) {
    throw new Error("FDB health check failed before optional read");
  }
  return await withFdbTimeout(operation(), FDB_OPTIONAL_OP_TIMEOUT_MS);
}

// Mutations are deliberately never wrapped in a JavaScript timeout and never
// fall back to PG. Await the definitive FDB retry loop; logical operations use
// stable ids so commit-unknown retries reconcile rather than duplicate work.
async function fdbMutation<T>(operation: () => Promise<T>): Promise<T> {
  return await operation();
}

const teamFdbStateKey = (teamId: string) => `nuq:fdb_team:${teamId}`;

async function markFdbTeamState(teamId: string): Promise<void> {
  // One bounded key per migrated team is the durable drain barrier. Failure is
  // fatal before the first FDB enqueue, so rollback can always identify teams
  // whose pinned FDB work may remain.
  await getRedisConnection().set(teamFdbStateKey(teamId), "1");
}

async function teamUsesFdbLedger(teamId: string): Promise<boolean> {
  if (!fdbQueueEnabled()) return false;
  if (fdbForced()) return true;
  if (await isFdbTeam(teamId)) return true;
  return (await getRedisConnection().get(teamFdbStateKey(teamId))) === "1";
}

// Whether NEW work for this team should go to FDB. Existing crawls follow
// their StoredCrawl.queueBackend marker instead.
export async function isFdbTeam(teamId: string | undefined): Promise<boolean> {
  if (!fdbQueueEnabled()) return false;
  if (fdbForced()) return true;
  if (!teamId) return false;
  let enabled = false;
  try {
    const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
    enabled = acuc?.flags?.nuqFdb === true;
  } catch (error) {
    _logger.warn("Failed to resolve nuqFdb team flag, defaulting to pg", {
      module: "nuq-router",
      teamId,
      error,
    });
  }
  if (enabled) await markFdbTeamState(teamId);
  return enabled;
}

export async function resolveNewGroupBackend(
  teamId: string,
): Promise<QueueBackend> {
  return (await isFdbTeam(teamId)) ? "fdb" : "pg";
}

// Reads only the queueBackend marker off the stored crawl. Deliberately not
// getCrawl() -- importing crawl-redis pulls the whole scraper tree in.
async function getCrawlQueueBackend(
  crawlId: string,
): Promise<QueueBackend | null> {
  if (fdbForced()) return "fdb";
  const raw = await redisEvictConnection.get("crawl:" + crawlId);
  if (raw) {
    try {
      const sc = JSON.parse(raw);
      if (sc?.queueBackend === "fdb") return "fdb";
      // Stored crawls predating the rollout have no marker and are PG.
      if (sc) return "pg";
    } catch {
      // Fall through to the authoritative FDB group probe.
    }
  }
  if (!fdbQueueEnabled()) return raw ? "pg" : null;
  const group = await optionalFdbRead(() => crawlGroupFdb.getGroup(crawlId));
  return group ? "fdb" : raw ? "pg" : null;
}

const jobBackendKey = (jobId: string) => `nuq:job_backend:${jobId}`;

async function markJobBackend(
  jobId: string,
  backend: QueueBackend,
): Promise<void> {
  if (fdbForced()) return;
  // This is only a bounded cache; never trust its absence. FDB job metadata
  // remains the durable source of truth after expiry or a failed write.
  await redisEvictConnection.set(
    jobBackendKey(jobId),
    backend,
    "EX",
    30 * 24 * 60 * 60,
  );
}

async function getJobQueueBackend(
  jobId: string,
  hint?: QueueBackend,
  hasFdbJob: () => Promise<boolean> = () => scrapeQueueFdb.hasJob(jobId),
): Promise<QueueBackend> {
  if (hint) return hint;
  if (fdbForced()) return "fdb";
  if ((await redisEvictConnection.get(jobBackendKey(jobId))) === "fdb") {
    return "fdb";
  }
  if (!fdbQueueEnabled()) return "pg";

  // Redis marker writes are best-effort and old markers may have expired.
  // Probe the durable FDB record before routing a wait/remove/read to PG.
  if (await optionalFdbRead(hasFdbJob)) {
    void markJobBackend(jobId, "fdb").catch(error =>
      _logger.warn("Failed to repair FDB job backend marker", {
        module: "nuq-router",
        jobId,
        error,
      }),
    );
    return "fdb";
  }
  return "pg";
}

// Which backend a job belongs to at enqueue time. Crawl jobs follow their
// crawl's pinned backend; standalone jobs follow the team flag.
export async function resolveJobBackend(
  data: ScrapeJobData,
): Promise<QueueBackend> {
  if (!fdbQueueEnabled()) return "pg";
  if (fdbForced()) return "fdb";
  if (data.crawl_id) {
    return (await getCrawlQueueBackend(data.crawl_id)) ?? "pg";
  }
  return (await isFdbTeam(data.team_id)) ? "fdb" : "pg";
}

function tagFdbJob<T extends object>(job: T): T & { backend: "fdb" } {
  (job as any).backend = "fdb";
  return job as T & { backend: "fdb" };
}

// === External capacity holders (browser sessions, sync scrapes)
//
// Non-queue work that occupies team capacity mirrors itself into whichever
// ledger the team runs on. Mismatched acquire/release pairs (flag flipped
// mid-hold) self-heal: Redis entries expire by score, FDB external slots are
// reaped by the sweeper.

async function acquireExternalSlot(
  teamId: string,
  holderId: string,
  ttlMs: number,
): Promise<void> {
  if (await isFdbTeam(teamId)) {
    if (!isSelfHosted()) await markFdbTeamState(teamId);
    await fdbMutation(() => externalSlotsFdb.acquire(teamId, holderId, ttlMs));
    return;
  }
  await pushConcurrencyLimitActiveJob(teamId, holderId, ttlMs);
  await syncFdbLimitToPgOccupancy(teamId);
}

export async function reserveExternalSlot(
  teamId: string,
  holderId: string,
  ttlMs: number,
  concurrencyLimit: number,
): Promise<boolean> {
  return await withTeamMigrationAdmission(teamId, async () => {
    if ((await getCombinedTeamActiveCount(teamId)) >= concurrencyLimit) {
      return false;
    }
    await acquireExternalSlot(teamId, holderId, ttlMs);
    return true;
  });
}

export async function mirrorExternalSlotAcquire(
  teamId: string,
  holderId: string,
  ttlMs: number,
): Promise<void> {
  await withTeamMigrationAdmission(teamId, async () =>
    acquireExternalSlot(teamId, holderId, ttlMs),
  );
}

export async function mirrorExternalSlotRelease(
  teamId: string,
  holderId: string,
): Promise<void> {
  await withTeamMigrationAdmission(teamId, async () => {
    // The flag may flip while a holder is alive. Route by the durable slot,
    // rather than today's flag, so rollback cannot leak FDB occupancy.
    if (
      fdbForced() ||
      ((await teamUsesFdbLedger(teamId)) &&
        (await optionalFdbRead(() => externalSlotsFdb.has(teamId, holderId))))
    ) {
      await fdbMutation(() => externalSlotsFdb.release(teamId, holderId));
      return;
    }
    await removeConcurrencyLimitActiveJob(teamId, holderId);
    await syncFdbLimitToPgOccupancy(teamId);
  });
}

// Active count across both ledgers; a migrating team has load on both while
// its old PG crawls drain.
export async function syncFdbLimitToPgOccupancy(teamId: string): Promise<void> {
  if (!(await teamUsesFdbLedger(teamId)) || isSelfHosted()) return;
  const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
  await reconcileFdbTeamLimit(teamId, acuc?.concurrency ?? 2);
}

export async function reconcileFdbTeamLimit(
  teamId: string,
  teamLimit: number,
): Promise<void> {
  if (!fdbQueueEnabled()) return;
  const externalActive = await getConcurrencyLimitActiveJobsCount(teamId);
  await fdbMutation(() =>
    scrapeQueueFdb.setTeamLimit(teamId, teamLimit, externalActive),
  );
}

export async function getCombinedTeamPendingCount(
  teamId: string,
): Promise<number> {
  if (fdbForced() && isSelfHosted()) {
    return await optionalFdbRead(() =>
      scrapeQueueFdb.getTeamPendingCount(teamId),
    );
  }
  const pgPending = await getRedisConnection().zcard(
    `concurrency-limit-queue:${teamId}`,
  );
  if (!(await teamUsesFdbLedger(teamId))) return pgPending;
  return (
    pgPending +
    (await optionalFdbRead(() => scrapeQueueFdb.getTeamPendingCount(teamId)))
  );
}

export async function getCombinedTeamActiveCount(
  teamId: string,
): Promise<number> {
  if (fdbForced() && isSelfHosted()) {
    return await optionalFdbRead(() =>
      scrapeQueueFdb.getTeamActiveCount(teamId),
    );
  }
  const redisCount = await getConcurrencyLimitActiveJobsCount(teamId);
  if (!(await teamUsesFdbLedger(teamId))) return redisCount;
  // Always include FDB for migrated teams, even after the rollout flag is
  // switched off. Pinned FDB crawls and standalone jobs keep draining and
  // remain part of the team's one combined limit.
  return (
    redisCount +
    (await optionalFdbRead(() => scrapeQueueFdb.getTeamActiveCount(teamId)))
  );
}

// === FDB enqueue (the whole gating block of queue-jobs collapses into this)

export function backlogTimeoutMsForGate(timeoutMs: number): Date {
  return new Date(Date.now() + timeoutMs);
}

// PG and FDB cannot share a transaction, so serialize cross-ledger admission
// while taking the combined occupancy snapshot and reserving the chosen
// backend. Redlock's using() extends this lease while a large enqueue runs.
export async function withTeamMigrationAdmission<T>(
  teamId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!fdbQueueEnabled() || (fdbForced() && isSelfHosted())) {
    return await operation();
  }
  return await redlock.using(
    [`nuq:migration-admission:${teamId}`],
    30_000,
    {},
    async signal => {
      if (signal.aborted) throw signal.error;
      const result = await operation();
      if (signal.aborted) throw signal.error;
      return result;
    },
  );
}

export async function fdbEnqueueScrapeJobs(
  jobs: {
    jobId: string;
    data: ScrapeJobData;
    priority: number;
    listenable?: boolean;
    backlogTimeoutMs: number;
  }[],
  teamId: string,
  options?: { bypassGate?: boolean; reservedExternalPending?: number },
): Promise<{
  jobs: (NuQJob<ScrapeJobData> & { backend: "fdb" })[];
  backloggedCount: number;
  teamLimit: number | null;
}> {
  if (!isSelfHosted()) await markFdbTeamState(teamId);
  let teamLimit: number | null = null;
  if (!isSelfHosted() && !fdbForced()) {
    const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
    teamLimit = acuc?.concurrency ?? 2;
  } else if (!isSelfHosted()) {
    const acuc = await getACUCTeam(teamId, false, true, RateLimiterMode.Crawl);
    teamLimit = acuc?.concurrency ?? null;
  }

  const queueCap =
    teamLimit === null ? Number.MAX_SAFE_INTEGER : getTeamQueueLimit(teamLimit);

  // API-key-scoped concurrency: applies when every job in the batch was
  // requested with the same key (batches always are; child jobs inherit the
  // kickoff's apiKeyId) and that key has a limit configured.
  let keyGate: { id: string; limit: number } | null = null;
  if (teamLimit !== null) {
    const keyIds = new Set(jobs.map(j => j.data.apiKeyId ?? null));
    const apiKeyId = keyIds.size === 1 ? [...keyIds][0] : null;
    if (apiKeyId !== null) {
      const keyLimit = await getApiKeyConcurrencyLimit(apiKeyId);
      if (keyLimit !== null) {
        keyGate = { id: String(apiKeyId), limit: keyLimit };
      }
    }
  }

  const externalActive =
    teamLimit === null ? 0 : await getConcurrencyLimitActiveJobsCount(teamId);
  const externalPending =
    teamLimit === null
      ? 0
      : (await getRedisConnection().zcard(
          `concurrency-limit-queue:${teamId}`,
        )) + (options?.reservedExternalPending ?? 0);
  const results = await fdbMutation(() =>
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
      {
        teamLimit,
        queueCap,
        externalActive,
        externalPending,
        key: keyGate,
      },
    ),
  );

  const tagged = results.map(r => tagFdbJob(r as NuQJob<ScrapeJobData>));
  for (const job of tagged) {
    void markJobBackend(job.id, "fdb").catch(error =>
      _logger.warn("Failed to cache FDB job backend", {
        module: "nuq-router",
        jobId: job.id,
        error,
      }),
    );
  }
  return {
    jobs: tagged,
    backloggedCount: tagged.filter(j => j.status === "backlog").length,
    teamLimit,
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
  ): Promise<NuQJob<ScrapeJobData> | null> {
    // Optional deployments have dedicated PG and FDB consumers. Never race a
    // mutating FDB take against PG fallback: an ambiguous FDB commit would
    // otherwise lease an invisible "ghost" job while this worker runs PG work.
    if (fdbForced()) {
      const job = await fdbMutation(() =>
        scrapeQueueFdb.getJobToProcess(logger),
      );
      if (job) {
        this.inflightBackend.set(job.id, "fdb");
        return tagFdbJob(job as NuQJob<ScrapeJobData>);
      }
      return null;
    }
    const job = await scrapeQueuePg.getJobToProcess();
    if (job) this.inflightBackend.set(job.id, "pg");
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    if (this.backendFor(id) === "fdb") {
      return await fdbMutation(() =>
        scrapeQueueFdb.renewLock(id, lock, logger),
      );
    }
    return scrapeQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    if (backend === "fdb") {
      const finished = await fdbMutation(() =>
        scrapeQueueFdb.jobFinish(id, lock, returnvalue, logger),
      );
      if (finished) this.inflightBackend.delete(id);
      return finished;
    }
    const finished = await scrapeQueuePg.jobFinish(
      id,
      lock,
      returnvalue,
      logger,
    );
    if (finished) this.inflightBackend.delete(id);
    return finished;
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.backendFor(id);
    if (backend === "fdb") {
      const failed = await fdbMutation(() =>
        scrapeQueueFdb.jobFail(id, lock, failedReason, logger),
      );
      if (failed) this.inflightBackend.delete(id);
      return failed;
    }
    const failed = await scrapeQueuePg.jobFail(id, lock, failedReason, logger);
    if (failed) this.inflightBackend.delete(id);
    return failed;
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData> | null> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      const job = await optionalFdbRead(() =>
        scrapeQueueFdb.getJob(id, logger),
      );
      return job ? tagFdbJob(job as NuQJob<ScrapeJobData>) : null;
    }
    return scrapeQueuePg.getJob(id, logger);
  }

  public async getJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    if (ids.length === 0) return [];
    const backends = await Promise.all(ids.map(id => getJobQueueBackend(id)));
    const fdbIds = ids.filter((_, i) => backends[i] === "fdb");
    const pgIds = ids.filter((_, i) => backends[i] === "pg");
    const [fdbJobs, pgJobs] = await Promise.all([
      fdbIds.length > 0
        ? optionalFdbRead(() => scrapeQueueFdb.getJobs(fdbIds, logger))
        : Promise.resolve([] as NuQFdbJob<ScrapeJobData>[]),
      pgIds.length > 0
        ? scrapeQueuePg.getJobs(pgIds, logger)
        : Promise.resolve([] as NuQJob<ScrapeJobData>[]),
    ]);
    const byId = new Map<string, NuQJob<ScrapeJobData>>();
    for (const j of fdbJobs)
      byId.set(j.id, tagFdbJob(j as NuQJob<ScrapeJobData>));
    for (const j of pgJobs) byId.set(j.id, j);
    return ids
      .map(id => byId.get(id))
      .filter((j): j is NuQJob<ScrapeJobData> => j !== undefined);
  }

  public async getJobsWithStatus(
    ids: string[],
    status: NuQJobStatus,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    return (await this.getJobs(ids, logger)).filter(j => j.status === status);
  }

  public async getJobsWithStatuses(
    ids: string[],
    statuses: NuQJobStatus[],
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    const set = new Set(statuses);
    return (await this.getJobs(ids, logger)).filter(j => set.has(j.status));
  }

  private async isFdbGroup(groupId: string): Promise<boolean> {
    const backend = await getCrawlQueueBackend(groupId);
    if (backend) return backend === "fdb";
    return fdbForced();
  }

  public async getGroupAnyJob(
    groupId: string,
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData> | null> {
    if (await this.isFdbGroup(groupId)) {
      const job = await optionalFdbRead(() =>
        scrapeQueueFdb.getGroupAnyJob(groupId, ownerId, logger),
      );
      return job ? tagFdbJob(job as NuQJob<ScrapeJobData>) : null;
    }
    return scrapeQueuePg.getGroupAnyJob(groupId, ownerId);
  }

  public async getGroupNumericStats(
    groupId: string,
    logger: Logger = _logger,
  ): Promise<Record<NuQJobStatus, number>> {
    if (await this.isFdbGroup(groupId)) {
      return (await optionalFdbRead(() =>
        scrapeQueueFdb.getGroupNumericStats(groupId, logger),
      )) as Record<NuQJobStatus, number>;
    }
    return scrapeQueuePg.getGroupNumericStats(groupId, logger);
  }

  public async getCrawlJobsForListing(
    groupId: string,
    limit: number,
    offset: number,
    logger: Logger = _logger,
  ): Promise<NuQJob<ScrapeJobData>[]> {
    if (await this.isFdbGroup(groupId)) {
      const jobs = await optionalFdbRead(() =>
        scrapeQueueFdb.getCrawlJobsForListing(groupId, limit, offset, logger),
      );
      return jobs.map(j => tagFdbJob(j as NuQJob<ScrapeJobData>));
    }
    return scrapeQueuePg.getCrawlJobsForListing(groupId, limit, offset, logger);
  }

  public async removeJob(id: string, logger: Logger = _logger): Promise<void> {
    if ((await getJobQueueBackend(id)) === "fdb") {
      await fdbMutation(() => scrapeQueueFdb.removeJob(id, logger));
      return;
    }
    await scrapeQueuePg.removeJob(id, logger);
  }

  public async removeJobs(
    ids: string[],
    logger: Logger = _logger,
  ): Promise<void> {
    for (const id of ids) {
      await this.removeJob(id, logger);
    }
  }

  public async waitForJob<T = any>(
    id: string,
    timeout: number | null,
    logger: Logger = _logger,
    backendHint?: QueueBackend,
  ): Promise<T> {
    if ((await getJobQueueBackend(id, backendHint)) === "fdb") {
      // Waiting is intentionally long-lived; callers pass the real scrape
      // timeout. The backend hint from the enqueue result also avoids any
      // dependency on the best-effort Redis marker.
      return scrapeQueueFdb.waitForJob(id, timeout, logger);
    }
    return scrapeQueuePg.waitForJob(id, timeout, logger) as Promise<T>;
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
  ): Promise<NuQJob<any> | null> {
    if (fdbForced()) {
      const job = await fdbMutation(() =>
        crawlFinishedQueueFdb.getJobToProcess(logger),
      );
      if (job) {
        this.inflightBackend.set(job.id, "fdb");
        return tagFdbJob(job as NuQJob<any>);
      }
      return null;
    }
    const job = await crawlFinishedQueuePg.getJobToProcess();
    if (job) this.inflightBackend.set(job.id, "pg");
    return job;
  }

  public async renewLock(
    id: string,
    lock: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    if (this.inflightBackend.get(id) === "fdb") {
      return await fdbMutation(() =>
        crawlFinishedQueueFdb.renewLock(id, lock, logger),
      );
    }
    return crawlFinishedQueuePg.renewLock(id, lock, logger);
  }

  public async jobFinish(
    id: string,
    lock: string,
    returnvalue: any | null,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    if (backend === "fdb") {
      const finished = await fdbMutation(() =>
        crawlFinishedQueueFdb.jobFinish(id, lock, returnvalue, logger),
      );
      if (finished) this.inflightBackend.delete(id);
      return finished;
    }
    const finished = await crawlFinishedQueuePg.jobFinish(
      id,
      lock,
      returnvalue,
      logger,
    );
    if (finished) this.inflightBackend.delete(id);
    return finished;
  }

  public async jobFail(
    id: string,
    lock: string,
    failedReason: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = this.inflightBackend.get(id) ?? "pg";
    if (backend === "fdb") {
      const failed = await fdbMutation(() =>
        crawlFinishedQueueFdb.jobFail(id, lock, failedReason, logger),
      );
      if (failed) this.inflightBackend.delete(id);
      return failed;
    }
    const failed = await crawlFinishedQueuePg.jobFail(
      id,
      lock,
      failedReason,
      logger,
    );
    if (failed) this.inflightBackend.delete(id);
    return failed;
  }

  public async getJob(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJob<any> | null> {
    if (
      (await getJobQueueBackend(id, undefined, () =>
        crawlFinishedQueueFdb.hasJob(id),
      )) === "fdb"
    ) {
      const job = await optionalFdbRead(() =>
        crawlFinishedQueueFdb.getJob(id, logger),
      );
      return job ? tagFdbJob(job as NuQJob<any>) : null;
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
      if (!isSelfHosted()) await markFdbTeamState(ownerId);
      const g = await fdbMutation(() =>
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
      return g as NuQJobGroupInstance;
    }
    return crawlGroupPg.addGroup(id, ownerId, ttl, logger);
  }

  public async getGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance | null> {
    const backend = await getCrawlQueueBackend(id);
    if (backend === "fdb" || (!backend && fdbForced())) {
      return (await optionalFdbRead(() =>
        crawlGroupFdb.getGroup(id, logger),
      )) as NuQJobGroupInstance | null;
    }
    return crawlGroupPg.getGroup(id, logger);
  }

  public async getOngoingByOwner(
    ownerId: string,
    logger: Logger = _logger,
  ): Promise<NuQJobGroupInstance[]> {
    if (!(await teamUsesFdbLedger(ownerId))) {
      return crawlGroupPg.getOngoingByOwner(ownerId, logger);
    }
    const fdb = (await optionalFdbRead(() =>
      crawlGroupFdb.getOngoingByOwner(ownerId, logger),
    )) as NuQJobGroupInstance[];
    if (fdbForced()) return fdb;
    // Query both ledgers regardless of today's flag. Turning the flag off only
    // stops new FDB groups; pinned groups remain authoritative until drained.
    const pg = await crawlGroupPg.getOngoingByOwner(ownerId, logger);
    const seen = new Set(fdb.map(g => g.id));
    return [
      ...(fdb as NuQJobGroupInstance[]),
      ...pg.filter(g => !seen.has(g.id)),
    ];
  }

  // O(1) cancel; only meaningful for FDB groups. PG crawls keep their
  // existing Redis-based cancellation path.
  public async cancelGroup(
    id: string,
    logger: Logger = _logger,
  ): Promise<boolean> {
    const backend = await getCrawlQueueBackend(id);
    if (backend !== "fdb" && !(backend === null && fdbForced())) return false;
    return await fdbMutation(() => crawlGroupFdb.cancelGroup(id, logger));
  }
}

export const scrapeQueue = new RoutedScrapeQueue();
export const crawlFinishedQueue = new RoutedCrawlFinishedQueue();
export const crawlGroup = new RoutedCrawlGroup();
