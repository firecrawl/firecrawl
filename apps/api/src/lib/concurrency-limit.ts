import { RateLimiterMode } from "../types";
import { getRedisConnection } from "../services/queue-service";
import { getACUCTeam } from "../controllers/auth";
import { getCrawl, StoredCrawl } from "./crawl-redis";
import { logger } from "./logger";
import { abTestJob } from "../services/ab-test";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";

const constructKey = (team_id: string) => "concurrency-limiter:" + team_id;
const constructQueueKey = (team_id: string) =>
  "concurrency-limit-queue:" + team_id;

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

export async function getConcurrencyLimitActiveJobsCount(
  team_id: string,
): Promise<number> {
  return await getRedisConnection().zcount(
    constructKey(team_id),
    Date.now(),
    Infinity,
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

export async function pushConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
  timeout: number,
  now: number = Date.now(),
) {
  await getRedisConnection().zadd(constructKey(team_id), now + timeout, id);
}

export async function removeConcurrencyLimitActiveJob(
  team_id: string,
  id: string,
) {
  await getRedisConnection().zrem(constructKey(team_id), id);
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
      ? Math.min(timeout, 172800000)
      : 172800000; // cap at 48h, fallback for NaN/Infinity
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
  await pipeline.exec();
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

  // Jobs we popped but can't run due to crawl concurrency limits.
  // We'll re-add them at the end so other callers can try them later.
  const crawlBlocked: { member: string; score: number; jobData: string }[] = [];

  try {
    while (true) {
      // ZPOPMIN atomically removes and returns the lowest-scored member.
      // No two workers can ever get the same entry.
      const result = await redis.zpopmin(queueKey);
      if (!result || result.length === 0) return null;

      const [member, scoreStr] = result as [string, string];
      const score = parseFloat(scoreStr);

      // Expired entry - discard
      if (score < now) {
        await redis.del(constructJobKey(member));
        continue;
      }

      const jobData = await redis.get(constructJobKey(member));
      if (jobData === null) {
        // Job key TTL expired - orphaned sorted set entry, already removed by zpopmin
        continue;
      }

      const job: ConcurrencyLimitedJob = JSON.parse(jobData);

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
            // Crawl is at its limit - hold this job aside to re-add later
            crawlBlocked.push({ member, score, jobData });
            continue;
          }
        }
      }

      // We got a valid, eligible job
      await redis.del(constructJobKey(member));
      logger.debug("Removed job from concurrency limit queue", {
        teamId,
        jobId: job.id,
        zeroDataRetention: job.data?.zeroDataRetention,
      });
      return { job, timeout: Infinity };
    }
  } finally {
    // Re-add crawl-blocked jobs so they can be picked up later
    if (crawlBlocked.length > 0) {
      const zaddArgs: (string | number)[] = [];
      for (const { member, score } of crawlBlocked) {
        zaddArgs.push(score, member);
      }
      await redis.zadd(queueKey, ...zaddArgs);
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

    const maxTeamConcurrency =
      (
        await getACUCTeam(
          job.data.team_id,
          false,
          true,
          job.data.is_extract ? RateLimiterMode.Extract : RateLimiterMode.Crawl,
        )
      )?.concurrency ?? 2;

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
