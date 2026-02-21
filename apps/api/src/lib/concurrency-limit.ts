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

/**
 * Check if a crawl has capacity for another job.
 * Returns true if the crawl has no concurrency limit or is under the limit.
 * On Redis errors, returns true to avoid blocking jobs (fail-open).
 */
async function checkCrawlHasCapacity(
  crawlId: string | undefined,
  crawlCache: Map<string, StoredCrawl>,
): Promise<boolean> {
  if (!crawlId) return true;

  try {
    const sc = crawlCache.get(crawlId) ?? (await getCrawl(crawlId));
    if (sc !== null) {
      crawlCache.set(crawlId, sc);
    }

    const maxCrawlConcurrency =
      sc === null
        ? null
        : typeof sc.crawlerOptions?.delay === "number" &&
            sc.crawlerOptions.delay > 0
          ? 1
          : (sc.maxConcurrency ?? null);

    if (maxCrawlConcurrency === null) return true;

    const currentActiveConcurrency = (
      await getCrawlConcurrencyLimitActiveJobs(crawlId)
    ).length;

    return currentActiveConcurrency < maxCrawlConcurrency;
  } catch (e) {
    // Redis error - fail open to avoid blocking jobs
    logger.warn("Redis error checking crawl capacity, allowing promotion", {
      crawlId,
      error: e,
    });
    return true;
  }
}

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
  const queueKey = constructQueueKey(team_id);
  const jobKey = constructJobKey(job.id);
  const redis = getRedisConnection();

  if (timeout === Infinity) {
    await redis.set(jobKey, JSON.stringify(job), "EX", 172800); // 48h
  } else {
    await redis.set(jobKey, JSON.stringify(job), "PX", timeout);
  }

  await redis.zadd(queueKey, now + timeout, job.id);
  await redis.sadd("concurrency-limit-queues", queueKey);
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

async function removeCrawlConcurrencyLimitActiveJob(
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
async function getNextConcurrentJob(
  teamId: string,
  i = 0,
): Promise<{
  job: ConcurrencyLimitedJob;
  timeout: number;
} | null> {
  let finalJobs: {
    job: ConcurrencyLimitedJob;
    _member: string;
    timeout: number;
  }[] = [];

  const crawlCache = new Map<string, StoredCrawl>();
  const queueKey = constructQueueKey(teamId);
  const redis = getRedisConnection();
  let offset = 0;

  do {
    const members = await redis.zrangebyscore(
      queueKey,
      Date.now(),
      "+inf",
      "LIMIT",
      offset,
      20,
    );

    if (members.length === 0) break;
    offset += members.length;

    for (const member of members) {
      const jobData = await redis.get(constructJobKey(member));
      if (jobData === null) {
        // TTL expired - remove orphaned sorted set entry
        await redis.zrem(queueKey, member);
        offset--;
        continue;
      }
      const job: ConcurrencyLimitedJob = JSON.parse(jobData);

      const res = {
        job,
        _member: member,
        timeout: Infinity,
      };

      // If the job is associated with a crawl ID, we need to check if the crawl has a max concurrency limit
      if (res.job.data.crawl_id) {
        const sc =
          crawlCache.get(res.job.data.crawl_id) ??
          (await getCrawl(res.job.data.crawl_id));
        if (sc !== null) {
          crawlCache.set(res.job.data.crawl_id, sc);
        }

        const maxCrawlConcurrency =
          sc === null
            ? null
            : typeof sc.crawlerOptions?.delay === "number" &&
                sc.crawlerOptions.delay > 0
              ? 1
              : (sc.maxConcurrency ?? null);

        if (maxCrawlConcurrency !== null) {
          // If the crawl has a max concurrency limit, we need to check if the crawl has reached the limit
          const currentActiveConcurrency = (
            await getCrawlConcurrencyLimitActiveJobs(res.job.data.crawl_id)
          ).length;
          if (currentActiveConcurrency < maxCrawlConcurrency) {
            // If we're under the max concurrency limit, we can run the job
            finalJobs.push(res);
          }
        } else {
          // If the crawl has no max concurrency limit, we can run the job
          finalJobs.push(res);
        }
      } else {
        // If the job is not associated with a crawl ID, we can run the job
        finalJobs.push(res);
      }
    }
  } while (finalJobs.length === 0);

  let finalJob: (typeof finalJobs)[number] | null = null;
  if (finalJobs.length > 0) {
    for (const job of finalJobs) {
      const res = await getRedisConnection().zrem(
        constructQueueKey(teamId),
        job._member,
      );
      if (res !== 0) {
        await getRedisConnection().del(constructJobKey(job._member));
        finalJob = job;
        break;
      }
    }

    if (finalJob === null) {
      // It's normal for this to happen, but if it happens too many times, we should log a warning
      if (i > 100) {
        logger.error(
          "Failed to remove job from concurrency limit queue, hard bailing",
          {
            teamId,
            jobIds: finalJobs.map(x => x.job.id),
            zeroDataRetention: finalJobs.some(
              x => x.job.data?.zeroDataRetention,
            ),
            i,
          },
        );
        return null;
      } else if (i > 15) {
        logger.warn("Failed to remove job from concurrency limit queue", {
          teamId,
          jobIds: finalJobs.map(x => x.job.id),
          zeroDataRetention: finalJobs.some(x => x.job.data?.zeroDataRetention),
          i,
        });
      }

      return await new Promise((resolve, reject) =>
        setTimeout(
          () => {
            getNextConcurrentJob(teamId, i + 1)
              .then(resolve)
              .catch(reject);
          },
          Math.floor(Math.random() * 300),
        ),
      ); // Stagger the workers off to break up the clump that causes the race condition
    } else {
      logger.debug("Removed job from concurrency limit queue", {
        teamId,
        jobId: finalJob.job.id,
        zeroDataRetention: finalJob.job.data?.zeroDataRetention,
        i,
      });
    }
  }

  // Fallback: if Redis queue returned no eligible jobs, query NuQ backlog directly.
  // This handles two cases:
  // 1. Race condition where Redis scan missed eligible jobs due to timing
  // 2. Redis data loss where the queue is empty but NuQ backlog has jobs
  if (finalJob === null) {
    try {
      const backlogJobIds = await scrapeQueue.getBackloggedJobIDsOfOnwer(
        teamId,
        logger,
      );

      if (backlogJobIds.length > 0) {
        const backlogJobs = await scrapeQueue.getJobsFromBacklog(
          backlogJobIds,
          logger,
        );

        for (const job of backlogJobs) {
          // Check if crawl has capacity (fail-open on Redis errors)
          const hasCapacity = await checkCrawlHasCapacity(
            job.data?.crawl_id,
            crawlCache,
          );

          if (hasCapacity) {
            logger.info(
              "Found eligible job in NuQ backlog fallback (Redis queue was empty)",
              {
                teamId,
                jobId: job.id,
                crawlId: job.data?.crawl_id,
                zeroDataRetention: job.data?.zeroDataRetention,
              },
            );

            return {
              job: {
                id: job.id,
                data: job.data,
                priority: job.priority,
                listenable: job.listenChannelId !== undefined,
              },
              timeout: Infinity,
            };
          }
        }
      }
    } catch (e) {
      logger.warn(
        "Error in NuQ backlog fallback, continuing without fallback",
        {
          teamId,
          error: e,
        },
      );
    }
  }

  return finalJob;
}

/**
 * Called when a job associated with a concurrency queue is done.
 *
 * @param job The BullMQ job that is done.
 */
export async function concurrentJobDone(job: NuQJob<any>) {
  if (job.id && job.data && job.data.team_id) {
    await removeConcurrencyLimitActiveJob(job.data.team_id, job.id);
    await cleanOldConcurrencyLimitEntries(job.data.team_id);
    await cleanOldConcurrencyLimitedJobs(job.data.team_id);

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
