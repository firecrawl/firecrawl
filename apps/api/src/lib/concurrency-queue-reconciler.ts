import { Logger } from "winston";
import { validate as isUUID } from "uuid";
import { getACUCTeam } from "../controllers/auth";
import { getRedisConnection } from "../services/queue-service";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import {
  getCombinedTeamActiveCount,
  sweepNuQMigrationGc,
  syncFdbLimitToPgOccupancy,
  type NuQMigrationGcSweepStats,
} from "../services/worker/nuq-router";
import {
  completeNuQPgPublication,
  type NuQPgPublication,
} from "../services/worker/nuq-pg-publication";
import { RateLimiterMode, type ScrapeJobData } from "../types";
import {
  acknowledgeConcurrentJob,
  getConcurrencyLimitActiveJobs,
  getNextConcurrentJob,
  MAX_BACKLOG_TIMEOUT_MS,
  pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob,
  pushCrawlConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
  removeCrawlConcurrencyLimitActiveJob,
  restoreConcurrentJob,
} from "./concurrency-limit";
import { getCrawl } from "./crawl-redis";
import { logger as _logger } from "./logger";

interface ReconcileOptions {
  teamId?: string;
  logger?: Logger;
  signal?: AbortSignal;
}

interface ReconcileResult {
  teamsScanned: number;
  teamsWithDrift: number;
  jobsRequeued: number;
  jobsStarted: number;
  migrationGc: NuQMigrationGcSweepStats;
}

function isExtractJob(data: ScrapeJobData): boolean {
  return "is_extract" in data && !!data.is_extract;
}

function publicationForBacklogJob(
  ownerId: string,
  job: Pick<NuQJob<ScrapeJobData>, "id" | "data">,
): NuQPgPublication {
  return {
    id: job.id,
    ownerId,
    groupId: job.data.crawl_id,
    placement: "backlog",
  };
}

function getBacklogJobTimeout(jobData: ScrapeJobData): number {
  if (jobData.crawl_id) return MAX_BACKLOG_TIMEOUT_MS;

  if ("scrapeOptions" in jobData && jobData.scrapeOptions?.timeout)
    return jobData.scrapeOptions.timeout;

  return 60 * 1000;
}

async function requeueJob(
  ownerId: string,
  job: NuQJob<ScrapeJobData>,
): Promise<void> {
  await pushConcurrencyLimitedJob(
    ownerId,
    {
      id: job.id,
      data: job.data,
      priority: job.priority,
      listenable: job.listenChannelId !== undefined,
    },
    getBacklogJobTimeout(job.data),
  );
}

async function reservePgActiveSlot(
  ownerId: string,
  jobId: string,
): Promise<void> {
  await pushConcurrencyLimitActiveJob(ownerId, jobId, 60 * 1000);
  try {
    await syncFdbLimitToPgOccupancy(ownerId);
  } catch (error) {
    await removeConcurrencyLimitActiveJob(ownerId, jobId);
    throw error;
  }
}

async function rollbackPgReservations(
  ownerId: string,
  jobId: string,
  crawlId?: string,
): Promise<void> {
  const removals: Promise<unknown>[] = [
    removeConcurrencyLimitActiveJob(ownerId, jobId),
  ];
  if (crawlId) {
    removals.push(removeCrawlConcurrencyLimitActiveJob(crawlId, jobId));
  }
  const results = await Promise.allSettled(removals);
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map(result => result.reason);
  try {
    await syncFdbLimitToPgOccupancy(ownerId);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to roll back PG reservations");
  }
}

async function getQueuedJobIDs(teamId: string): Promise<Set<string>> {
  const queuedJobIDs = new Set<string>();
  let cursor = "0";

  do {
    const [nextCursor, results] = await getRedisConnection().zscan(
      `concurrency-limit-queue:${teamId}`,
      cursor,
      "COUNT",
      100,
    );
    cursor = nextCursor;

    // zscan returns [member1, score1, member2, score2, ...]
    for (let i = 0; i < results.length; i += 2) {
      queuedJobIDs.add(results[i]);
    }
  } while (cursor !== "0");

  // A ZSET member without cq-job payload cannot be promoted and is not a
  // published backlog entry. Treat it as drift so the PG row repairs Redis.
  const ids = [...queuedJobIDs];
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const batch = ids.slice(offset, offset + 1000);
    const payloads = await getRedisConnection().mget(
      ...batch.map(id => `cq-job:${id}`),
    );
    payloads.forEach((payload, index) => {
      const id = batch[index];
      if (payload === null) {
        queuedJobIDs.delete(id);
        return;
      }
      try {
        if (JSON.parse(payload)?.id !== id) queuedJobIDs.delete(id);
      } catch {
        queuedJobIDs.delete(id);
      }
    });
  }
  return queuedJobIDs;
}

async function includeClaimedJobIDs(
  ownerId: string,
  ids: string[],
  published: Set<string>,
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const batch = ids.slice(offset, offset + 1000);
    const claims = await getRedisConnection().mget(
      ...batch.map(id => `cq-claim:${id}`),
    );
    claims.forEach((raw, index) => {
      if (!raw) return;
      try {
        if (JSON.parse(raw)?.teamId === ownerId) published.add(batch[index]);
      } catch {
        // Corrupt/expired claims are repaired through the ordinary DB path.
      }
    });
  }
}

async function reconcileTeam(
  ownerId: string,
  teamLogger: Logger,
): Promise<{ jobsStarted: number; jobsRequeued: number } | null> {
  const backloggedJobIDs = new Set(
    await scrapeQueue.getBackloggedJobIDsOfOwner(ownerId, teamLogger),
  );
  if (backloggedJobIDs.size === 0) {
    return null;
  }

  const queuedJobIDs = await getQueuedJobIDs(ownerId);
  await includeClaimedJobIDs(ownerId, [...backloggedJobIDs], queuedJobIDs);
  const healthyJobIDs = [...backloggedJobIDs].filter(id =>
    queuedJobIDs.has(id),
  );
  await completeNuQPgPublication(
    healthyJobIDs.map(id => ({
      id,
      ownerId,
      placement: "backlog" as const,
    })),
  );
  const missingJobIDs = [...backloggedJobIDs].filter(
    id => !queuedJobIDs.has(id),
  );

  if (missingJobIDs.length === 0) return null;

  const jobsToRecover = await scrapeQueue.getJobsFromBacklog(
    missingJobIDs,
    teamLogger,
  );
  if (jobsToRecover.length === 0) {
    return null;
  }

  const maxCrawlConcurrency =
    (await getACUCTeam(ownerId, false, true, RateLimiterMode.Crawl))
      ?.concurrency ?? 2;
  const maxExtractConcurrency =
    (await getACUCTeam(ownerId, false, true, RateLimiterMode.Extract))
      ?.concurrency ?? 2;

  // Split active count by type so one type's active jobs don't gate the other
  const activeJobIds = await getConcurrencyLimitActiveJobs(ownerId);
  const activeJobs = await scrapeQueue.getJobs(activeJobIds, teamLogger);
  let activeCrawlCount = 0;
  let activeExtractCount = 0;
  for (const aj of activeJobs) {
    if (isExtractJob(aj.data)) {
      activeExtractCount++;
    } else {
      activeCrawlCount++;
    }
  }
  // FDB jobs are not represented in the PG job rows used for type splitting.
  // Count them against either PG admission class so drift recovery cannot
  // reopen a second ledger's worth of slots during migration.
  const fdbActiveCount = Math.max(
    0,
    (await getCombinedTeamActiveCount(ownerId)) - activeJobs.length,
  );
  activeCrawlCount += fdbActiveCount;
  activeExtractCount += fdbActiveCount;

  const jobsToStart: typeof jobsToRecover = [];
  const jobsToQueue: typeof jobsToRecover = [];

  for (const job of jobsToRecover) {
    const isExtract = isExtractJob(job.data);
    const teamLimit = isExtract ? maxExtractConcurrency : maxCrawlConcurrency;
    const activeCount = isExtract ? activeExtractCount : activeCrawlCount;

    if (activeCount < teamLimit) {
      jobsToStart.push(job);
      if (isExtract) activeExtractCount++;
      else activeCrawlCount++;
    } else {
      jobsToQueue.push(job);
    }
  }

  let jobsStarted = 0;
  let jobsRequeued = 0;

  for (const job of jobsToQueue) {
    await requeueJob(ownerId, job);
    await completeNuQPgPublication([publicationForBacklogJob(ownerId, job)]);
    jobsRequeued++;
  }

  for (const job of jobsToStart) {
    await reservePgActiveSlot(ownerId, job.id);
    let crawlReserved = false;
    let promoted: NuQJob<ScrapeJobData> | null;
    try {
      if (job.data.crawl_id) {
        const sc = await getCrawl(job.data.crawl_id);
        if (sc?.crawlerOptions?.delay || sc?.maxConcurrency) {
          // Crawl reservation must precede worker-visible PG promotion.
          await pushCrawlConcurrencyLimitActiveJob(
            job.data.crawl_id,
            job.id,
            60 * 1000,
          );
          crawlReserved = true;
        }
      }
      promoted = await scrapeQueue.promoteJobFromBacklogOrAdd(
        job.id,
        job.data,
        {
          priority: job.priority,
          listenable: job.listenChannelId !== undefined,
          ownerId: job.data.team_id ?? undefined,
          groupId: job.data.crawl_id ?? undefined,
        },
      );
    } catch (error) {
      let materialized: NuQJob<ScrapeJobData> | null;
      try {
        materialized = await scrapeQueue.getJob(job.id, teamLogger);
      } catch {
        throw error;
      }
      if (!materialized) {
        await rollbackPgReservations(
          ownerId,
          job.id,
          crawlReserved ? job.data.crawl_id : undefined,
        );
      }
      throw error;
    }

    if (promoted !== null) {
      await completeNuQPgPublication(
        [publicationForBacklogJob(ownerId, job)],
        "promoted",
      );
      jobsStarted++;
    } else {
      await rollbackPgReservations(
        ownerId,
        job.id,
        crawlReserved ? job.data.crawl_id : undefined,
      );
      teamLogger.warn("Job promotion failed, re-queuing job", {
        jobId: job.id,
      });
      await requeueJob(ownerId, job);
      await completeNuQPgPublication([publicationForBacklogJob(ownerId, job)]);
      jobsRequeued++;
    }
  }

  teamLogger.info("Recovered drift in concurrency queue", {
    missingJobs: missingJobIDs.length,
    recoveredJobs: jobsToRecover.length,
    requeuedJobs: jobsRequeued,
    startedJobs: jobsStarted,
  });

  return { jobsStarted, jobsRequeued };
}

async function drainQueue(
  ownerId: string,
  teamLogger: Logger,
): Promise<{ jobsPromoted: number; staleSkipped: number }> {
  const maxCrawlConcurrency =
    (await getACUCTeam(ownerId, false, true, RateLimiterMode.Crawl))
      ?.concurrency ?? 2;
  const maxExtractConcurrency =
    (await getACUCTeam(ownerId, false, true, RateLimiterMode.Extract))
      ?.concurrency ?? 2;

  const activeIds = await getConcurrencyLimitActiveJobs(ownerId);
  const activeJobs = await scrapeQueue.getJobs(activeIds, teamLogger);
  let crawlCount = 0;
  let extractCount = 0;
  for (const aj of activeJobs) {
    if (isExtractJob(aj.data)) extractCount++;
    else crawlCount++;
  }
  const fdbActiveCount = Math.max(
    0,
    (await getCombinedTeamActiveCount(ownerId)) - activeJobs.length,
  );
  crawlCount += fdbActiveCount;
  extractCount += fdbActiveCount;

  let jobsPromoted = 0;
  let staleSkipped = 0;
  let typeBlocked = 0;

  while (staleSkipped + typeBlocked < 100) {
    if (
      crawlCount >= maxCrawlConcurrency &&
      extractCount >= maxExtractConcurrency
    )
      break;

    const nextJob = await getNextConcurrentJob(ownerId);
    if (nextJob === null) break;

    const isExtract = isExtractJob(nextJob.job.data);
    const typeLimit = isExtract ? maxExtractConcurrency : maxCrawlConcurrency;
    const typeCount = isExtract ? extractCount : crawlCount;

    if (typeCount >= typeLimit) {
      await restoreConcurrentJob(ownerId, nextJob);
      typeBlocked++;
      continue;
    }

    await reservePgActiveSlot(ownerId, nextJob.job.id);
    let crawlReserved = false;
    let promoted: NuQJob<ScrapeJobData> | null;
    try {
      if (nextJob.job.data.crawl_id) {
        await pushCrawlConcurrencyLimitActiveJob(
          nextJob.job.data.crawl_id,
          nextJob.job.id,
          60 * 1000,
        );
        crawlReserved = true;
      }
      promoted = await scrapeQueue.promoteJobFromBacklogOrAdd(
        nextJob.job.id,
        nextJob.job.data,
        {
          priority: nextJob.job.priority,
          listenable: nextJob.job.listenable,
          ownerId: nextJob.job.data.team_id ?? undefined,
          groupId: nextJob.job.data.crawl_id ?? undefined,
        },
      );
    } catch (error) {
      let materialized: NuQJob<ScrapeJobData> | null;
      try {
        materialized = await scrapeQueue.getJob(nextJob.job.id, teamLogger);
      } catch {
        throw error;
      }
      if (materialized) {
        await acknowledgeConcurrentJob(nextJob);
        throw error;
      }
      const cleanup = await Promise.allSettled([
        rollbackPgReservations(
          ownerId,
          nextJob.job.id,
          crawlReserved ? nextJob.job.data.crawl_id : undefined,
        ),
        restoreConcurrentJob(ownerId, nextJob),
      ]);
      const failures = cleanup.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length > 0) {
        throw new AggregateError(
          [error, ...failures.map(result => result.reason)],
          "PG queue drain and claim restoration both failed",
        );
      }
      throw error;
    }

    if (promoted !== null) {
      await completeNuQPgPublication(
        [publicationForBacklogJob(ownerId, nextJob.job)],
        "promoted",
      );
      await acknowledgeConcurrentJob(nextJob);
      if (isExtract) extractCount++;
      else crawlCount++;
      jobsPromoted++;
    } else {
      await rollbackPgReservations(
        ownerId,
        nextJob.job.id,
        crawlReserved ? nextJob.job.data.crawl_id : undefined,
      );
      await acknowledgeConcurrentJob(nextJob);
      staleSkipped++;
    }
  }

  if (staleSkipped >= 100) {
    teamLogger.warn(
      "Queue drain hit 100 stale entries without fully draining",
      { ownerId },
    );
  }

  return { jobsPromoted, staleSkipped };
}

export async function reconcileConcurrencyQueue(
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const logger = (options.logger ?? _logger).child({
    module: "concurrencyQueueReconciler",
    scopedTeamId: options.teamId,
  });

  let ownerIds: string[];
  if (options.teamId) {
    ownerIds = [options.teamId];
  } else {
    const backlogOwners = (
      await scrapeQueue.getBackloggedOwnerIDs(logger)
    ).filter((x): x is string => typeof x === "string");
    const queueKeys = await getRedisConnection().smembers(
      "concurrency-limit-queues",
    );
    const queueOwners = queueKeys
      .map(k => k.replace("concurrency-limit-queue:", ""))
      .filter(id => id.length > 0 && isUUID(id));
    ownerIds = [...new Set([...backlogOwners, ...queueOwners])];
  }

  const migrationGc = await sweepNuQMigrationGc({ signal: options.signal });

  const result: ReconcileResult = {
    teamsScanned: ownerIds.length,
    teamsWithDrift: 0,
    jobsRequeued: 0,
    jobsStarted: 0,
    migrationGc,
  };

  for (const ownerId of ownerIds) {
    if (options.signal?.aborted) break;
    const teamLogger = logger.child({ teamId: ownerId });

    try {
      const teamResult = await reconcileTeam(ownerId, teamLogger);
      if (teamResult !== null) {
        result.teamsWithDrift++;
        result.jobsStarted += teamResult.jobsStarted;
        result.jobsRequeued += teamResult.jobsRequeued;
      }

      const drainResult = await drainQueue(ownerId, teamLogger);
      if (drainResult.jobsPromoted > 0 || drainResult.staleSkipped > 0) {
        result.jobsStarted += drainResult.jobsPromoted;
        teamLogger.info("Queue drain promoted jobs", {
          jobsPromoted: drainResult.jobsPromoted,
          staleSkipped: drainResult.staleSkipped,
        });
      }
    } catch (error) {
      teamLogger.error("Failed to reconcile team, skipping", { error });
    }
  }

  return result;
}
