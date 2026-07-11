import { RateLimiterMode } from "../types";
import { getRedisConnection } from "../services/queue-service";
import { getACUCTeam } from "../controllers/auth";
import { getCrawl, StoredCrawl } from "./crawl-redis";
import { logger } from "./logger";
import { abTestJob } from "../services/ab-test";
import { scrapeQueue, type NuQJob } from "../services/worker/nuq";
import { syncFdbLimitToPgOccupancy } from "../services/worker/nuq-router";
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
  removeConcurrencyLimitActiveJob,
  reserveConcurrencyLimitActiveJob,
} from "./concurrency-redis";

const constructKey = constructConcurrencyLimitKey;
const constructQueueKey = (team_id: string) =>
  "concurrency-limit-queue:" + team_id;

const constructJobKey = (jobId: string) => "cq-job:" + jobId;

const constructCrawlKey = (crawl_id: string) =>
  "crawl-concurrency-limiter:" + crawl_id;

function assertRedisPipelineSucceeded(
  results: [Error | null, unknown][] | null,
  operation: string,
): void {
  const errors =
    results
      ?.map(([error]) => error)
      .filter((error): error is Error => error instanceof Error) ?? [];
  if (errors.length > 0) throw new AggregateError(errors, operation);
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
    assertRedisPipelineSucceeded(
      await pipeline.exec(),
      "Failed to remove concurrency-limited jobs",
    );
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
  assertRedisPipelineSucceeded(
    await pipeline.exec(),
    "Failed to publish concurrency-limited jobs",
  );
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
type ClaimedConcurrentJob = {
  job: ConcurrencyLimitedJob;
  timeout: number;
  score: number;
  token: string;
};

const constructClaimKey = (jobId: string) => `cq-claim:${jobId}`;

export async function getNextConcurrentJob(
  teamId: string,
): Promise<ClaimedConcurrentJob | null> {
  const crawlCache = new Map<string, StoredCrawl>();
  const queueKey = constructQueueKey(teamId);
  const redis = getRedisConnection();
  const now = Date.now();

  // Jobs we popped but can't run due to crawl concurrency limits.
  // We'll re-add them at the end so other callers can try them later.
  const crawlBlocked: { member: string; score: number; jobData: string }[] = [];
  let interruptedClaim: { member: string; score: number } | null = null;

  try {
    while (true) {
      // Atomically pop and publish a reconciler-visible ownership token.
      const token = crypto.randomUUID();
      const result = (await redis.eval(
        `local item = redis.call('ZPOPMIN', KEYS[1], 1)
         if #item == 0 then return item end
         redis.call('SET', 'cq-claim:' .. item[1], ARGV[1], 'PX', ARGV[2])
         return item`,
        1,
        queueKey,
        JSON.stringify({ teamId, token }),
        5 * 60 * 1000,
      )) as string[];
      if (!result || result.length === 0) return null;

      const [member, scoreStr] = result as [string, string];
      const score = parseFloat(scoreStr);
      interruptedClaim = { member, score };

      // Expired entry - discard
      if (score < now) {
        await redis.del(constructJobKey(member), constructClaimKey(member));
        interruptedClaim = null;
        continue;
      }

      const jobData = await redis.get(constructJobKey(member));
      if (jobData === null) {
        // Job key TTL expired - orphaned sorted set entry, already removed by zpopmin
        await redis.del(constructClaimKey(member));
        interruptedClaim = null;
        continue;
      }

      let job: ConcurrencyLimitedJob;
      try {
        job = JSON.parse(jobData);
      } catch (error) {
        logger.error("Discarding corrupt concurrency queue payload", {
          teamId,
          jobId: member,
          error,
        });
        await redis.del(constructJobKey(member), constructClaimKey(member));
        interruptedClaim = null;
        continue;
      }
      if (job.id !== member || job.data?.team_id !== teamId) {
        logger.error("Discarding mismatched concurrency queue payload", {
          teamId,
          member,
          payloadJobId: job.id,
          payloadTeamId: job.data?.team_id,
        });
        await redis.del(constructJobKey(member), constructClaimKey(member));
        interruptedClaim = null;
        continue;
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
            // Crawl is at its limit - hold this job aside to re-add later
            crawlBlocked.push({ member, score, jobData });
            interruptedClaim = null;
            continue;
          }
        }
      }

      // Keep cq-job until the caller has durably promoted or discarded the
      // claim. If anything after this destructive ZPOPMIN throws, the caller
      // can restore the original score without reconstructing payload/TTL.
      logger.debug("Claimed job from concurrency limit queue", {
        teamId,
        jobId: job.id,
        zeroDataRetention: job.data?.zeroDataRetention,
      });
      interruptedClaim = null;
      return { job, timeout: Infinity, score, token };
    }
  } finally {
    // Re-add crawl-blocked jobs and a pop interrupted by any downstream
    // exception so ZPOPMIN is never a destructive failure boundary.
    const toRestore = interruptedClaim
      ? [...crawlBlocked, { ...interruptedClaim, jobData: "" }]
      : crawlBlocked;
    if (toRestore.length > 0) {
      const zaddArgs: (string | number)[] = [];
      for (const { member, score } of toRestore) {
        zaddArgs.push(score, member);
      }
      const pipeline = redis.pipeline();
      pipeline.zadd(queueKey, ...zaddArgs);
      for (const { member } of toRestore) {
        pipeline.del(constructClaimKey(member));
      }
      assertRedisPipelineSucceeded(
        await pipeline.exec(),
        "Failed to restore interrupted concurrency claims",
      );
    }
  }
}

export async function acknowledgeConcurrentJob(
  claimed: ClaimedConcurrentJob,
): Promise<void> {
  await getRedisConnection().eval(
    `local raw = redis.call('GET', KEYS[2])
     if raw then
       local claim = cjson.decode(raw)
       if claim.token ~= ARGV[1] then return 0 end
     end
     redis.call('DEL', KEYS[1], KEYS[2])
     return 1`,
    2,
    constructJobKey(claimed.job.id),
    constructClaimKey(claimed.job.id),
    claimed.token,
  );
}

export async function restoreConcurrentJob(
  teamId: string,
  claimed: ClaimedConcurrentJob,
): Promise<void> {
  const redis = getRedisConnection();
  if (claimed.score <= Date.now()) {
    await acknowledgeConcurrentJob(claimed);
    return;
  }
  await redis.eval(
    `local raw = redis.call('GET', KEYS[3])
     if raw then
       local claim = cjson.decode(raw)
       if claim.token ~= ARGV[3] then return 0 end
     end
     redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
     redis.call('SADD', KEYS[2], KEYS[1])
     redis.call('DEL', KEYS[3])
     return 1`,
    3,
    constructQueueKey(teamId),
    "concurrency-limit-queues",
    constructClaimKey(claimed.job.id),
    claimed.score,
    claimed.job.id,
    claimed.token,
  );
}

/**
 * Called when a job associated with a concurrency queue is done.
 *
 * @param job The BullMQ job that is done.
 */
export async function concurrentJobDone(job: NuQJob<any>) {
  if (!job.id || !job.data?.team_id) return;

  const teamId = job.data.team_id;
  await removeConcurrencyLimitActiveJob(teamId, job.id);
  await getRedisConnection().zrem(constructQueueKey(teamId), job.id);
  await getRedisConnection().del(
    constructJobKey(job.id),
    constructClaimKey(job.id),
  );
  await cleanOldConcurrencyLimitEntries(teamId);
  await cleanOldConcurrencyLimitedJobs(teamId);

  if (job.data.crawl_id) {
    await removeCrawlConcurrencyLimitActiveJob(job.data.crawl_id, job.id);
    await cleanOldCrawlConcurrencyLimitEntries(job.data.crawl_id);
  }

  const maxTeamConcurrency =
    (
      await getACUCTeam(
        teamId,
        false,
        true,
        job.data.is_extract ? RateLimiterMode.Extract : RateLimiterMode.Crawl,
      )
    )?.concurrency ?? 2;
  await syncFdbLimitToPgOccupancy(teamId);

  const releaseClaimReservations = async (claimed: ClaimedConcurrentJob) => {
    const cleanup: Promise<unknown>[] = [
      removeConcurrencyLimitActiveJob(teamId, claimed.job.id),
    ];
    if (claimed.job.data.crawl_id) {
      cleanup.push(
        removeCrawlConcurrencyLimitActiveJob(
          claimed.job.data.crawl_id,
          claimed.job.id,
        ),
      );
    }
    const results = await Promise.allSettled(cleanup);
    await syncFdbLimitToPgOccupancy(teamId);
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length > 0) {
      throw new AggregateError(
        failed.map(result => (result as PromiseRejectedResult).reason),
        "Failed to release claimed concurrency reservations",
      );
    }
  };

  let staleSkipped = 0;
  while (staleSkipped < 100) {
    const claimed = await getNextConcurrentJob(teamId);
    if (claimed === null) break;

    try {
      const reservation = await reserveConcurrencyLimitActiveJob(
        teamId,
        claimed.job.id,
        maxTeamConcurrency,
        60 * 1000,
      );
      if (!reservation.reserved) {
        await restoreConcurrentJob(teamId, claimed);
        break;
      }

      await syncFdbLimitToPgOccupancy(teamId);

      if (claimed.job.data.crawl_id) {
        // Reserve crawl capacity before making the PG row worker-visible.
        await pushCrawlConcurrencyLimitActiveJob(
          claimed.job.data.crawl_id,
          claimed.job.id,
          60 * 1000,
        );
        const sc = await getCrawl(claimed.job.data.crawl_id);
        if (sc !== null && typeof sc.crawlerOptions?.delay === "number") {
          await new Promise(resolve =>
            setTimeout(resolve, sc.crawlerOptions.delay * 1000),
          );
        }
      }

      abTestJob(claimed.job.data);
      const promoted = await scrapeQueue.promoteJobFromBacklogOrAdd(
        claimed.job.id,
        claimed.job.data,
        {
          priority: claimed.job.priority,
          listenable: claimed.job.listenable,
          ownerId: claimed.job.data.team_id ?? undefined,
          groupId: claimed.job.data.crawl_id ?? undefined,
        },
      );

      if (promoted !== null) {
        await acknowledgeConcurrentJob(claimed);
        logger.debug("Successfully promoted concurrent queued job", {
          teamId,
          jobId: claimed.job.id,
          zeroDataRetention: claimed.job.data?.zeroDataRetention,
        });
        break;
      }

      await releaseClaimReservations(claimed);
      await acknowledgeConcurrentJob(claimed);
      staleSkipped++;
    } catch (error) {
      // Reconcile a possible PG commit before undoing reservations. If the
      // probe itself is unavailable, leave the payload and reservations for
      // the periodic reconciler rather than guessing after an ambiguous write.
      let materialized: NuQJob<any> | null;
      try {
        materialized = await scrapeQueue.getJob(claimed.job.id);
      } catch {
        throw error;
      }
      if (materialized) {
        await acknowledgeConcurrentJob(claimed);
        throw error;
      }

      const cleanup = await Promise.allSettled([
        releaseClaimReservations(claimed),
        restoreConcurrentJob(teamId, claimed),
      ]);
      const cleanupFailures = cleanup.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures.map(result => result.reason)],
          "Concurrent promotion and claim restoration both failed",
        );
      }
      throw error;
    }
  }

  if (staleSkipped >= 100) {
    logger.warn(
      "Skipped 100 stale entries in concurrency queue without a successful promotion",
      { teamId },
    );
  }
}
