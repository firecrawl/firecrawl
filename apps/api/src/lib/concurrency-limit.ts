import { RateLimiterMode } from "../types";
import { getACUCTeam } from "../controllers/auth";
import { getCrawl, StoredCrawl } from "./crawl-redis";
import { logger } from "./logger";
import { abTestJob } from "../services/ab-test";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import * as fdbQueue from "../services/fdb-queue-client";

// ============= Active Job Tracking =============

/**
 * Clean old concurrency limit entries (expired active jobs).
 * With FDB, this is handled automatically by the cleanup worker,
 * but we keep this function for backwards compatibility.
 */
export async function cleanOldConcurrencyLimitEntries(
  team_id: string,
  _now: number = Date.now(),
): Promise<void> {
  // FDB handles TTL cleanup automatically via cleanExpiredActiveJobs
  // This is a no-op for now, but kept for API compatibility
}

/**
 * Get count of active jobs for a team (non-expired only).
 */
export async function getConcurrencyLimitActiveJobsCount(
  team_id: string,
): Promise<number> {
  return await fdbQueue.getActiveJobCount(team_id);
}

/**
 * Get active job IDs for a team (non-expired only).
 */
export async function getConcurrencyLimitActiveJobs(
  team_id: string,
  _now: number = Date.now(),
): Promise<string[]> {
  return await fdbQueue.getActiveJobs(team_id);
}

/**
 * Push an active job entry (team level).
 */
export async function pushConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  timeout: number,
  _now: number = Date.now(),
): Promise<void> {
  await fdbQueue.pushActiveJob(team_id, id, timeout);
}

/**
 * Remove an active job entry (team level).
 */
export async function removeConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
): Promise<void> {
  await fdbQueue.removeActiveJob(team_id, id);
}

// ============= Concurrency Queue (Backlog) =============

type ConcurrencyLimitedJob = {
  id: string;
  data: any;
  priority: number;
  listenable: boolean;
  listenChannelId?: string;
};

/**
 * Clean old concurrency limited jobs (expired queued jobs).
 * With FDB, this is handled automatically by the cleanup worker.
 */
export async function cleanOldConcurrencyLimitedJobs(
  _team_id: string,
  _now: number = Date.now(),
): Promise<void> {
  // FDB handles TTL cleanup automatically via cleanExpiredJobs
  // This is a no-op for now, but kept for API compatibility
}

/**
 * Push a job to the concurrency queue (backlog).
 * This is called when a job exceeds the team's concurrency limit.
 */
export async function pushConcurrencyLimitedJob(
  team_id: string,
  job: ConcurrencyLimitedJob,
  timeout: number,
  _now: number = Date.now(),
): Promise<void> {
  await fdbQueue.pushJob(
    team_id,
    {
      id: job.id,
      data: job.data,
      priority: job.priority,
      listenable: job.listenable,
      listenChannelId: job.listenChannelId,
    },
    timeout,
    job.data?.crawl_id, // crawlId for the secondary index
  );
}

/**
 * Get count of queued jobs for a team.
 */
export async function getConcurrencyQueueJobsCount(
  team_id: string,
): Promise<number> {
  return await fdbQueue.getTeamQueueCount(team_id);
}

/**
 * Get queued job IDs for a team.
 * Returns a Set for efficient lookups.
 *
 * Note: For crawl-specific lookups, prefer getCrawlQueuedJobIds for better performance.
 */
export async function getConcurrencyLimitedJobs(
  team_id: string,
): Promise<Set<string>> {
  return await fdbQueue.getTeamQueuedJobIds(team_id);
}

/**
 * Get queued job IDs for a specific crawl.
 * More efficient than getConcurrencyLimitedJobs when you only need jobs for a specific crawl.
 */
// async function getCrawlQueuedJobIds(
//   crawl_id: string,
// ): Promise<Set<string>> {
//   return await fdbQueue.getCrawlQueuedJobIds(crawl_id);
// }

/**
 * Check if a specific job is in the queue for a crawl.
 * O(1) lookup using the crawl index.
 */
// async function isJobInCrawlQueue(
//   crawl_id: string,
//   job_id: string,
// ): Promise<boolean> {
//   return await fdbQueue.isJobInCrawlQueue(crawl_id, job_id);
// }

// ============= Crawl-Level Active Job Tracking =============

/**
 * Clean old crawl concurrency limit entries (expired active crawl jobs).
 * With FDB, this is handled automatically by the cleanup worker.
 */
async function cleanOldCrawlConcurrencyLimitEntries(
  _crawl_id: string,
  _now: number = Date.now(),
): Promise<void> {
  // FDB handles TTL cleanup automatically
}

/**
 * Get active job IDs for a crawl (non-expired only).
 */
export async function getCrawlConcurrencyLimitActiveJobs(
  crawl_id: string,
  _now: number = Date.now(),
): Promise<string[]> {
  return await fdbQueue.getCrawlActiveJobs(crawl_id);
}

/**
 * Push an active job entry (crawl level).
 */
export async function pushCrawlConcurrencyLimitActiveJob(
  crawl_id: string,
  id: string,
  timeout: number,
  _now: number = Date.now(),
): Promise<void> {
  await fdbQueue.pushCrawlActiveJob(crawl_id, id, timeout);
}

/**
 * Remove an active job entry (crawl level).
 */
async function removeCrawlConcurrencyLimitActiveJob(
  crawl_id: string,
  id: string,
): Promise<void> {
  await fdbQueue.removeCrawlActiveJob(crawl_id, id);
}

// ============= Job Processing =============

/**
 * Grabs the next job from the team's concurrency limit queue.
 * Handles crawl concurrency limits.
 *
 * This function returns jobs in proper priority order (priority ASC, then createdAt ASC).
 *
 * @param teamId The team ID to get the next job for.
 * @returns A job that can be run, or null if there are no more jobs to run.
 */
async function getNextConcurrentJob(teamId: string): Promise<{
  job: ConcurrencyLimitedJob;
  timeout: number;
} | null> {
  const crawlCache = new Map<string, StoredCrawl | null>();

  // Use FDB's popNextJob which properly orders by priority then createdAt
  // and atomically removes the job from the queue
  const crawlConcurrencyChecker = async (crawlId: string): Promise<boolean> => {
    let sc = crawlCache.get(crawlId);
    if (sc === undefined) {
      sc = await getCrawl(crawlId);
      crawlCache.set(crawlId, sc);
    }

    if (sc === null) {
      return true; // Crawl doesn't exist, allow the job
    }

    const maxCrawlConcurrency =
      typeof sc.crawlerOptions?.delay === "number" &&
      sc.crawlerOptions.delay > 0
        ? 1
        : (sc.maxConcurrency ?? null);

    if (maxCrawlConcurrency === null) {
      return true; // No limit
    }

    const currentActiveConcurrency = (
      await getCrawlConcurrencyLimitActiveJobs(crawlId)
    ).length;

    return currentActiveConcurrency < maxCrawlConcurrency;
  };

  const claimed = await fdbQueue.popNextJob(teamId, crawlConcurrencyChecker);

  if (claimed === null) {
    return null;
  }

  const fdbJob = claimed.job;

  // Complete the job immediately - we're promoting it from FDB backlog to main queue
  // The versionstamp claiming ensures only one worker successfully claims the job,
  // so completing it now is safe and removes it from the FDB queue.
  await fdbQueue.completeJob(claimed.queueKey);

  logger.debug("Claimed and completed job from concurrency limit queue (FDB)", {
    teamId,
    jobId: fdbJob.id,
    priority: fdbJob.priority,
    zeroDataRetention: fdbJob.data?.zeroDataRetention,
  });

  return {
    job: {
      id: fdbJob.id,
      data: fdbJob.data,
      priority: fdbJob.priority,
      listenable: fdbJob.listenable,
      listenChannelId: fdbJob.listenChannelId,
    },
    timeout: fdbJob.timesOutAt ? fdbJob.timesOutAt - Date.now() : Infinity,
  };
}

/**
 * Called when a job associated with a concurrency queue is done.
 * This function removes the job from active tracking and promotes
 * the next job from the queue if there's capacity.
 *
 * @param job The NuQ job that is done.
 */
export async function concurrentJobDone(job: NuQJob<any>): Promise<void> {
  if (job.id && job.data && job.data.team_id) {
    await removeConcurrencyLimitActiveJob(job.data.team_id, job.id);
    await cleanOldConcurrencyLimitEntries(job.data.team_id);

    if (job.data.crawl_id) {
      await removeCrawlConcurrencyLimitActiveJob(job.data.crawl_id, job.id);
      await cleanOldCrawlConcurrencyLimitEntries(job.data.crawl_id);
    }

    let i = 0;
    for (; i < 10; i++) {
      const maxTeamConcurrency =
        (
          await getACUCTeam(
            job.data.team_id,
            false,
            true,
            job.data.is_extract
              ? RateLimiterMode.Extract
              : RateLimiterMode.Crawl,
          )
        )?.concurrency ?? 2;
      const currentActiveConcurrency = (
        await getConcurrencyLimitActiveJobs(job.data.team_id)
      ).length;

      if (currentActiveConcurrency < maxTeamConcurrency) {
        const nextJob = await getNextConcurrentJob(job.data.team_id);
        if (nextJob !== null) {
          await pushConcurrencyLimitActiveJob(
            job.data.team_id,
            nextJob.job.id,
            60 * 1000,
          );

          if (nextJob.job.data.crawl_id) {
            await pushCrawlConcurrencyLimitActiveJob(
              nextJob.job.data.crawl_id,
              nextJob.job.id,
              60 * 1000,
            );

            const sc = await getCrawl(nextJob.job.data.crawl_id);
            if (sc !== null && typeof sc.crawlerOptions?.delay === "number") {
              await new Promise(resolve =>
                setTimeout(resolve, sc.crawlerOptions.delay * 1000),
              );
            }
          }

          abTestJob(nextJob.job.data);

          // With FDB, jobs are no longer in the PG backlog.
          // We just add the job directly to the queue.
          const addedSuccessfully =
            (await scrapeQueue.addJob(nextJob.job.id, nextJob.job.data, {
              priority: nextJob.job.priority,
              listenable: nextJob.job.listenable,
              ownerId: nextJob.job.data.team_id ?? undefined,
              groupId: nextJob.job.data.crawl_id ?? undefined,
            })) !== null;

          if (addedSuccessfully) {
            logger.debug("Successfully promoted concurrent queued job", {
              teamId: job.data.team_id,
              jobId: nextJob.job.id,
              zeroDataRetention: nextJob.job.data?.zeroDataRetention,
            });
            break;
          } else {
            logger.warn(
              "Was unable to promote concurrent queued job as it already exists in the database",
              {
                teamId: job.data.team_id,
                jobId: nextJob.job.id,
                zeroDataRetention: nextJob.job.data?.zeroDataRetention,
              },
            );
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (i === 10) {
      logger.warn(
        "Failed to promote a concurrent job after 10 iterations, bailing!",
        {
          teamId: job.data.team_id,
        },
      );
    }
  }
}
