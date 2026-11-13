import { getRedisConnection } from "../services/queue-service";
import { getCrawl, StoredCrawl } from "./crawl-redis";
import { logger } from "./logger";
import { abTestJob } from "../services/ab-test";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import { normalizeOwnerId } from "./owner-id";
export { QueueFullError } from "./queue-full-error";
export {
  getTeamQueueLimit,
  MAX_BACKLOG_TIMEOUT_MS,
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "./concurrency-redis";
import {
  getTeamQueueLimit,
  MAX_BACKLOG_TIMEOUT_MS,
  constructConcurrencyLimitKey,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "./concurrency-redis";
import { getACUCTeam } from "../controllers/auth";
import { DEFAULT_TEAM_LIMITS } from "../services/autumn/autumn.service";
import { reportPipelineError } from "./redis-pipeline";

/**
 * CONCURRENCY granted by the Autumn `hobby` plan (firecrawl-web
 * autumn.config.ts). Pairs with HOBBY_RATE_LIMIT_MULTIPLIER in
 * services/rate-limiter.ts; change both if the hobby plan changes.
 */
export const HOBBY_CONCURRENCY_LIMIT = 5;

const constructKey = constructConcurrencyLimitKey;
export const constructQueueKey = (team_id: string) =>
  "concurrency-limit-queue:" + (normalizeOwnerId(team_id) ?? team_id);

const constructJobKey = (jobId: string) => "cq-job:" + jobId;

const constructCrawlKey = (crawl_id: string) =>
  "crawl-concurrency-limiter:" + crawl_id;

export async function cleanOldConcurrencyLimitEntries(
  team_id: string,
  now: number = Date.now(),
) {
  await getRedisConnection().zremrangebyscore(
    constructKey(team_id),
    -Infinity,
    now,
  );
}

export async function getConcurrencyLimitActiveJobs(
  team_id: string,
  now: number = Date.now(),
): Promise<string[]> {
  return await getRedisConnection().zrangebyscore(
    constructKey(team_id),
    now,
    Infinity,
  );
}

export async function removeConcurrencyLimitedJobs(
  team_id: string,
  job_ids: string[],
) {
  if (job_ids.length === 0) return;
  const redis = getRedisConnection();
  const queueKey = constructQueueKey(team_id);
  const chunkSize = 1000;
  for (let i = 0; i < job_ids.length; i += chunkSize) {
    const chunk = job_ids.slice(i, i + chunkSize);
    const pipeline = redis.pipeline();
    pipeline.zrem(queueKey, ...chunk);
    for (const id of chunk) {
      pipeline.del(constructJobKey(id));
    }
    // Do not throw on command errors: cancel has already been recorded on
    // the crawl, and the stale entries self-expire via their PX timeout.
    // But never let the failure pass silently.
    reportPipelineError(await pipeline.exec(), logger, {
      module: "concurrency-limit",
      method: "removeConcurrencyLimitedJobs",
      teamId: team_id,
      jobCount: chunk.length,
    });
  }
}

type ConcurrencyLimitedJob = {
  id: string;
  data: any;
  priority: number;
  listenable: boolean;
};

export async function cleanOldConcurrencyLimitedJobs(
  team_id: string,
  now: number = Date.now(),
) {
  await getRedisConnection().zremrangebyscore(
    constructQueueKey(team_id),
    -Infinity,
    now,
  );
}

export async function pushConcurrencyLimitedJob(
  team_id: string,
  job: ConcurrencyLimitedJob,
  timeout: number,
  now: number = Date.now(),
) {
  await pushConcurrencyLimitedJobs(team_id, [{ job, timeout }], now);
}

export async function pushConcurrencyLimitedJobs(
  team_id: string,
  jobs: { job: ConcurrencyLimitedJob; timeout: number }[],
  now: number = Date.now(),
) {
  if (jobs.length === 0) {
    return;
  }

  const queueKey = constructQueueKey(team_id);
  const redis = getRedisConnection();
  const pipeline = redis.pipeline();
  const zaddArgs: (string | number)[] = [];

  for (const { job, timeout } of jobs) {
    const cappedTimeout = Number.isFinite(timeout)
      ? Math.min(timeout, MAX_BACKLOG_TIMEOUT_MS)
      : MAX_BACKLOG_TIMEOUT_MS;
    pipeline.set(
      constructJobKey(job.id),
      JSON.stringify(job),
      "PX",
      cappedTimeout,
    );
    zaddArgs.push(now + cappedTimeout, job.id);
  }

  pipeline.zadd(queueKey, ...zaddArgs);
  pipeline.sadd("concurrency-limit-queues", queueKey);
  // Do not throw on command errors: the jobs are already durable in the
  // NuQ backlog, and the concurrency-queue reconciler requeues anything
  // missing from this derived Redis index on its next run. But never let
  // the failure pass silently.
  reportPipelineError(await pipeline.exec(), logger, {
    module: "concurrency-limit",
    method: "pushConcurrencyLimitedJobs",
    teamId: team_id,
    jobCount: jobs.length,
  });
}

export async function getConcurrencyLimitedJobs(team_id: string) {
  return new Set(
    await getRedisConnection().zrange(constructQueueKey(team_id), 0, -1),
  );
}

export async function getConcurrencyQueueJobsCount(
  team_id: string,
): Promise<number> {
  return await getRedisConnection().zcount(
    constructQueueKey(team_id),
    Date.now(),
    Infinity,
  );
}

async function cleanOldCrawlConcurrencyLimitEntries(
  crawl_id: string,
  now: number = Date.now(),
) {
  await getRedisConnection().zremrangebyscore(
    constructCrawlKey(crawl_id),
    -Infinity,
    now,
  );
}

export async function getCrawlConcurrencyLimitActiveJobs(
  crawl_id: string,
  now: number = Date.now(),
): Promise<string[]> {
  return await getRedisConnection().zrangebyscore(
    constructCrawlKey(crawl_id),
    now,
    Infinity,
  );
}

export async function pushCrawlConcurrencyLimitActiveJob(
  crawl_id: string,
  id: string,
  timeout: number,
  now: number = Date.now(),
) {
  await getRedisConnection().zadd(
    constructCrawlKey(crawl_id),
    now + timeout,
    id,
  );
}

export async function removeCrawlConcurrencyLimitActiveJob(
  crawl_id: string,
  id: string,
) {
  await getRedisConnection().zrem(constructCrawlKey(crawl_id), id);
}

/**
 * Grabs the next job from the team's concurrency limit queue. Handles crawl concurrency limits.
 *
 * This function may only be called once the outer code has verified that the team has not reached its concurrency limit.
 *
 * @param teamId
 * @returns A job that can be run, or null if there are no more jobs to run.
 */
export async function getNextConcurrentJob(teamId: string): Promise<{
  job: ConcurrencyLimitedJob;
  timeout: number;
} | null> {
  const crawlCache = new Map<string, StoredCrawl>();
  const queueKey = constructQueueKey(teamId);
  const redis = getRedisConnection();
  const now = Date.now();
  const BATCH_SIZE = 50;
  let offset = 0;

  while (true) {
    // Inspect candidates in batches without removing crawl-blocked jobs.
    // Crawl-blocked jobs remain in Redis so that pod crashes / scale-downs
    // do not strand them from Redis.
    const results = await redis.zrange(
      queueKey,
      offset,
      offset + BATCH_SIZE - 1,
      "WITHSCORES",
    );
    if (!results || results.length === 0) return null;

    let scannedInBatch = 0;
    let claimedOrAdvanced = false;

    for (let i = 0; i < results.length; i += 2) {
      scannedInBatch++;
      const member = results[i];
      const score = parseFloat(results[i + 1]);

      // Expired entry - discard
      if (score < now) {
        await redis.zrem(queueKey, member);
        await redis.del(constructJobKey(member));
        claimedOrAdvanced = true;
        break;
      }

      const jobData = await redis.get(constructJobKey(member));
      if (jobData === null) {
        // Job key TTL expired - orphaned sorted set entry
        await redis.zrem(queueKey, member);
        claimedOrAdvanced = true;
        break;
      }

      let job: ConcurrencyLimitedJob;
      try {
        job = JSON.parse(jobData);
      } catch {
        await redis.zrem(queueKey, member);
        await redis.del(constructJobKey(member));
        claimedOrAdvanced = true;
        break;
      }

      // Check crawl concurrency limit
      if (job.data.crawl_id) {
        const sc =
          crawlCache.get(job.data.crawl_id) ??
          (await getCrawl(job.data.crawl_id));
        if (sc !== null) {
          crawlCache.set(job.data.crawl_id, sc);
        }

        const maxCrawlConcurrency =
          sc === null
            ? null
            : typeof sc.crawlerOptions?.delay === "number" &&
                sc.crawlerOptions.delay > 0
              ? 1
              : (sc.maxConcurrency ?? null);

        if (maxCrawlConcurrency !== null) {
          const currentActiveConcurrency = (
            await getCrawlConcurrencyLimitActiveJobs(job.data.crawl_id)
          ).length;
          if (currentActiveConcurrency >= maxCrawlConcurrency) {
            // Crawl is at its limit - leave it in Redis and evaluate next candidate
            offset++;
            continue;
          }
        }
      }

      // Atomically claim the eligible job
      const removed = await redis.zrem(queueKey, member);
      if (removed === 0) {
        // Another worker claimed it concurrently, retry from current offset
        claimedOrAdvanced = true;
        break;
      }

      // We successfully claimed this job
      await redis.del(constructJobKey(member));
      logger.debug("Removed job from concurrency limit queue", {
        teamId,
        jobId: job.id,
        zeroDataRetention: job.data?.zeroDataRetention,
      });
      return { job, timeout: Infinity };
    }

    if (!claimedOrAdvanced) {
      // If we scanned all candidates in this batch and all were crawl-blocked,
      // and the batch returned fewer than BATCH_SIZE items, we reached the end of the queue.
      if (
        results.length < BATCH_SIZE * 2 &&
        scannedInBatch === results.length / 2
      ) {
        return null;
      }
    }
  }
}

/**
 * Called when a job associated with a concurrency queue is done.
 *
 * @param job The BullMQ job that is done.
 */
export async function concurrentJobDone(job: NuQJob<any>) {
  if (job.id && job.data && job.data.team_id) {
    await removeConcurrencyLimitActiveJob(job.data.team_id, job.id);
    await getRedisConnection().zrem(
      constructQueueKey(job.data.team_id),
      job.id,
    );
    await getRedisConnection().del(constructJobKey(job.id));
    await cleanOldConcurrencyLimitEntries(job.data.team_id);
    await cleanOldConcurrencyLimitedJobs(job.data.team_id);

    if (job.data.crawl_id) {
      await removeCrawlConcurrencyLimitActiveJob(job.data.crawl_id, job.id);
      await cleanOldCrawlConcurrencyLimitEntries(job.data.crawl_id);
    }

    // Once per call, not once per job promoted below.
    const maxTeamConcurrency =
      (await getACUCTeam(job.data.team_id).catch(() => null))
        ?.concurrency_limit ?? DEFAULT_TEAM_LIMITS.concurrency_limit;

    let staleSkipped = 0;
    while (staleSkipped < 100) {
      const currentActiveConcurrency = (
        await getConcurrencyLimitActiveJobs(job.data.team_id)
      ).length;

      if (currentActiveConcurrency >= maxTeamConcurrency) break;

      const nextJob = await getNextConcurrentJob(job.data.team_id);
      if (nextJob === null) break;

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

      const promotedSuccessfully =
        (await scrapeQueue.promoteJobFromBacklogOrAdd(
          nextJob.job.id,
          nextJob.job.data,
          {
            priority: nextJob.job.priority,
            listenable: nextJob.job.listenable,
            ownerId: nextJob.job.data.team_id ?? undefined,
            groupId: nextJob.job.data.crawl_id ?? undefined,
          },
        )) !== null;

      if (promotedSuccessfully) {
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
        await removeConcurrencyLimitActiveJob(job.data.team_id, nextJob.job.id);
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
      logger.warn(
        "Skipped 100 stale entries in concurrency queue without a successful promotion",
        {
          teamId: job.data.team_id,
        },
      );
    }
  }
}
