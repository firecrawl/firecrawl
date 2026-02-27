import { Logger } from "winston";
import { getACUCTeam } from "../controllers/auth";
import { getRedisConnection } from "../services/queue-service";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import { RateLimiterMode, type ScrapeJobData } from "../types";
import {
  getConcurrencyLimitActiveJobs,
  getNextConcurrentJob,
  pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob,
  pushCrawlConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
  removeCrawlConcurrencyLimitActiveJob,
} from "./concurrency-limit";
import { getCrawl } from "./crawl-redis";
import { logger as _logger } from "./logger";

interface ReconcileOptions {
  teamId?: string;
  logger?: Logger;
}

interface ReconcileResult {
  teamsScanned: number;
  teamsWithDrift: number;
  jobsRequeued: number;
  jobsStarted: number;
}

function isExtractJob(data: ScrapeJobData): boolean {
  return "is_extract" in data && !!data.is_extract;
}

function getBacklogJobTimeout(jobData: ScrapeJobData): number {
  if (jobData.crawl_id) return Infinity;

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

  return queuedJobIDs;
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
  const missingJobIDs = [...backloggedJobIDs].filter(x => !queuedJobIDs.has(x));

  if (missingJobIDs.length === 0) {
    return null;
  }

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
    jobsRequeued++;
  }

  for (const job of jobsToStart) {
    const promoted = await scrapeQueue.promoteJobFromBacklogOrAdd(
      job.id,
      job.data,
      {
        priority: job.priority,
        listenable: job.listenChannelId !== undefined,
        ownerId: job.data.team_id ?? undefined,
        groupId: job.data.crawl_id ?? undefined,
      },
    );

    if (promoted !== null) {
      await pushConcurrencyLimitActiveJob(ownerId, job.id, 60 * 1000);

      if (job.data.crawl_id) {
        const sc = await getCrawl(job.data.crawl_id);
        if (sc?.crawlerOptions?.delay || sc?.maxConcurrency) {
          await pushCrawlConcurrencyLimitActiveJob(
            job.data.crawl_id,
            job.id,
            60 * 1000,
          );
        }
      }

      jobsStarted++;
    } else {
      teamLogger.warn("Job promotion failed, re-queuing job", {
        jobId: job.id,
      });
      await requeueJob(ownerId, job);
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
      await pushConcurrencyLimitedJob(
        ownerId,
        {
          id: nextJob.job.id,
          data: nextJob.job.data,
          priority: nextJob.job.priority,
          listenable: nextJob.job.listenable,
        },
        nextJob.timeout === Infinity ? 172800000 : nextJob.timeout,
      );
      typeBlocked++;
      continue;
    }

    await pushConcurrencyLimitActiveJob(ownerId, nextJob.job.id, 60 * 1000);
    if (nextJob.job.data.crawl_id) {
      await pushCrawlConcurrencyLimitActiveJob(
        nextJob.job.data.crawl_id,
        nextJob.job.id,
        60 * 1000,
      );
    }

    const promoted = await scrapeQueue.promoteJobFromBacklogOrAdd(
      nextJob.job.id,
      nextJob.job.data,
      {
        priority: nextJob.job.priority,
        listenable: nextJob.job.listenable,
        ownerId: nextJob.job.data.team_id ?? undefined,
        groupId: nextJob.job.data.crawl_id ?? undefined,
      },
    );

    if (promoted !== null) {
      if (isExtract) extractCount++;
      else crawlCount++;
      jobsPromoted++;
    } else {
      await removeConcurrencyLimitActiveJob(ownerId, nextJob.job.id);
      if (nextJob.job.data.crawl_id) {
        await removeCrawlConcurrencyLimitActiveJob(
          nextJob.job.data.crawl_id,
          nextJob.job.id,
        );
      }
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
      .filter(id => id.length > 0);
    ownerIds = [...new Set([...backlogOwners, ...queueOwners])];
  }

  const result: ReconcileResult = {
    teamsScanned: ownerIds.length,
    teamsWithDrift: 0,
    jobsRequeued: 0,
    jobsStarted: 0,
  };

  for (const ownerId of ownerIds) {
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
