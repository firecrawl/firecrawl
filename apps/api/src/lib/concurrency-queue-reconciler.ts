import { Logger } from "winston";
import { getRedisConnection } from "../services/queue-service";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import { type ScrapeJobData } from "../types";
import {
  getConcurrencyLimitActiveJobs,
  getNextConcurrentJob,
  getCrawlConcurrencyLimitActiveJobs,
  MAX_BACKLOG_TIMEOUT_MS,
  pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob,
  pushCrawlConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
  removeCrawlConcurrencyLimitActiveJob,
} from "./concurrency-limit";
import { getCrawl } from "./crawl-redis";
import { logger as _logger } from "./logger";
import { getACUCTeam } from "../controllers/auth";
import { DEFAULT_TEAM_LIMITS } from "../services/autumn/autumn.service";
import { normalizeOwnerId } from "./owner-id";

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
  if (jobData.crawl_id) return MAX_BACKLOG_TIMEOUT_MS;

  if ("scrapeOptions" in jobData && jobData.scrapeOptions?.timeout)
    return jobData.scrapeOptions.timeout;

  return 60 * 1000;
}

async function requeueJob(
  teamId: string,
  job: NuQJob<ScrapeJobData>,
): Promise<void> {
  await pushConcurrencyLimitedJob(
    teamId,
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
  teamId: string,
  teamLogger: Logger,
): Promise<{
  teamId: string;
  hasDrift: boolean;
  jobsStarted: number;
  jobsRequeued: number;
} | null> {
  const backloggedJobIDs = new Set(
    await scrapeQueue.getBackloggedJobIDsOfOwner(ownerId, teamLogger),
  );
  if (backloggedJobIDs.size === 0) {
    return null;
  }

  // NuQ stores a normalized owner UUID, while Redis concurrency keys use the
  // original team ID. The backlog payload is the durable source for that ID;
  // the Redis key index may have been cleaned up when its sorted set emptied.
  const backlogTeamId =
    (await scrapeQueue.getBackloggedTeamIdOfOwner(ownerId, teamLogger)) ??
    teamId;

  const queuedJobIDs = await getQueuedJobIDs(backlogTeamId);
  const missingJobIDs = [...backloggedJobIDs].filter(x => !queuedJobIDs.has(x));

  if (missingJobIDs.length === 0) {
    return {
      teamId: backlogTeamId,
      hasDrift: false,
      jobsStarted: 0,
      jobsRequeued: 0,
    };
  }

  const jobsToRecover = await scrapeQueue.getJobsFromBacklog(
    missingJobIDs,
    teamLogger,
  );
  if (jobsToRecover.length === 0) {
    return {
      teamId: backlogTeamId,
      hasDrift: false,
      jobsStarted: 0,
      jobsRequeued: 0,
    };
  }

  // Autumn's CONCURRENCY balance is a single per-team pool, so crawl and
  // extract share the same effective limit.
  // TODO: gate crawl + extract against one combined pool (sum of both active
  // counts vs the single limit) instead of applying the same limit to each
  // type independently.
  const teamConcurrency =
    (await getACUCTeam(ownerId))?.concurrency_limit ??
    DEFAULT_TEAM_LIMITS.concurrency_limit;
  const maxCrawlConcurrency = teamConcurrency;
  const maxExtractConcurrency = teamConcurrency;

  // Split active count by type so one type's active jobs don't gate the other
  const activeJobIds = await getConcurrencyLimitActiveJobs(backlogTeamId);
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
  const crawlConcurrency = new Map<
    string,
    { limit: number | null; active: number }
  >();

  for (const job of jobsToRecover) {
    const isExtract = isExtractJob(job.data);
    const teamLimit = isExtract ? maxExtractConcurrency : maxCrawlConcurrency;
    const activeCount = isExtract ? activeExtractCount : activeCrawlCount;

    let crawlState: { limit: number | null; active: number } | undefined;
    if (job.data.crawl_id) {
      crawlState = crawlConcurrency.get(job.data.crawl_id);
      if (!crawlState) {
        const crawl = await getCrawl(job.data.crawl_id);
        const limit =
          crawl === null
            ? null
            : typeof crawl.crawlerOptions?.delay === "number" &&
                crawl.crawlerOptions.delay > 0
              ? 1
              : (crawl.maxConcurrency ?? null);
        crawlState = {
          limit,
          active:
            limit === null
              ? 0
              : (await getCrawlConcurrencyLimitActiveJobs(job.data.crawl_id))
                  .length,
        };
        crawlConcurrency.set(job.data.crawl_id, crawlState);
      }
    }

    const crawlHasCapacity =
      !crawlState ||
      crawlState.limit === null ||
      crawlState.active < crawlState.limit;

    if (activeCount < teamLimit && crawlHasCapacity) {
      jobsToStart.push(job);
      if (isExtract) activeExtractCount++;
      else activeCrawlCount++;
      if (crawlState) crawlState.active++;
    } else {
      jobsToQueue.push(job);
    }
  }

  let jobsStarted = 0;
  let jobsRequeued = 0;

  for (const job of jobsToQueue) {
    await requeueJob(backlogTeamId, job);
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
      await pushConcurrencyLimitActiveJob(backlogTeamId, job.id, 60 * 1000);

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
      await requeueJob(backlogTeamId, job);
      jobsRequeued++;
    }
  }

  teamLogger.info("Recovered drift in concurrency queue", {
    missingJobs: missingJobIDs.length,
    recoveredJobs: jobsToRecover.length,
    requeuedJobs: jobsRequeued,
    startedJobs: jobsStarted,
  });

  return {
    teamId: backlogTeamId,
    hasDrift: true,
    jobsStarted,
    jobsRequeued,
  };
}

async function drainQueue(
  ownerId: string,
  teamId: string,
  teamLogger: Logger,
): Promise<{ jobsPromoted: number; staleSkipped: number }> {
  // Autumn's CONCURRENCY balance is a single per-team pool, so crawl and
  // extract share the same effective limit.
  // TODO: gate crawl + extract against one combined pool (sum of both active
  // counts vs the single limit) instead of applying the same limit to each
  // type independently.
  const teamConcurrency =
    (await getACUCTeam(ownerId))?.concurrency_limit ??
    DEFAULT_TEAM_LIMITS.concurrency_limit;
  const maxCrawlConcurrency = teamConcurrency;
  const maxExtractConcurrency = teamConcurrency;

  const activeIds = await getConcurrencyLimitActiveJobs(teamId);
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

    const nextJob = await getNextConcurrentJob(teamId);
    if (nextJob === null) break;

    const isExtract = isExtractJob(nextJob.job.data);
    const typeLimit = isExtract ? maxExtractConcurrency : maxCrawlConcurrency;
    const typeCount = isExtract ? extractCount : crawlCount;

    if (typeCount >= typeLimit) {
      await pushConcurrencyLimitedJob(
        teamId,
        {
          id: nextJob.job.id,
          data: nextJob.job.data,
          priority: nextJob.job.priority,
          listenable: nextJob.job.listenable,
        },
        nextJob.timeout === Infinity ? MAX_BACKLOG_TIMEOUT_MS : nextJob.timeout,
      );
      typeBlocked++;
      continue;
    }

    await pushConcurrencyLimitActiveJob(teamId, nextJob.job.id, 60 * 1000);
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
      await removeConcurrencyLimitActiveJob(teamId, nextJob.job.id);
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

  let teamScopes: { ownerId: string; teamId: string }[];
  if (options.teamId) {
    teamScopes = [
      {
        ownerId: normalizeOwnerId(options.teamId) ?? options.teamId,
        teamId: options.teamId,
      },
    ];
  } else {
    const backlogOwners = (
      await scrapeQueue.getBackloggedOwnerIDs(logger)
    ).filter((x): x is string => typeof x === "string");
    const queueKeys = await getRedisConnection().smembers(
      "concurrency-limit-queues",
    );
    const scopesByTeamId = new Map<
      string,
      { ownerId: string; teamId: string }
    >();
    const queuePrefix = "concurrency-limit-queue:";
    for (const key of queueKeys) {
      if (!key.startsWith(queuePrefix)) continue;
      const teamId = key.slice(queuePrefix.length);
      const ownerId = normalizeOwnerId(teamId);
      if (ownerId) scopesByTeamId.set(teamId, { ownerId, teamId });
    }
    const ownersWithQueue = new Set(
      [...scopesByTeamId.values()].map(scope => scope.ownerId),
    );
    for (const ownerId of backlogOwners) {
      if (!ownersWithQueue.has(ownerId)) {
        scopesByTeamId.set(ownerId, { ownerId, teamId: ownerId });
      }
    }
    teamScopes = [...scopesByTeamId.values()];
  }

  const result: ReconcileResult = {
    teamsScanned: teamScopes.length,
    teamsWithDrift: 0,
    jobsRequeued: 0,
    jobsStarted: 0,
  };

  for (const { ownerId, teamId } of teamScopes) {
    const teamLogger = logger.child({ teamId: ownerId });

    try {
      const teamResult = await reconcileTeam(ownerId, teamId, teamLogger);
      let effectiveTeamId = teamId;
      if (teamResult !== null) {
        effectiveTeamId = teamResult.teamId;
        if (teamResult.hasDrift) result.teamsWithDrift++;
        result.jobsStarted += teamResult.jobsStarted;
        result.jobsRequeued += teamResult.jobsRequeued;
      }

      const drainResult = await drainQueue(
        ownerId,
        effectiveTeamId,
        teamLogger,
      );
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
