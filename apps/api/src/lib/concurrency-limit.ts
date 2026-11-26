import { z } from "zod";
import { getRedisConnection } from "../services/queue-service";
import type { StoredCrawl } from "./crawl-redis";
import { getCrawl } from "./crawl-redis";
import { logger } from "./logger";
import { scrapeQueue } from "../services/worker/nuq";
import type { NuQJob } from "../services/worker/nuq";
export { QueueFullError } from "./queue-full-error";
export {
  getTeamQueueLimit,
  MAX_BACKLOG_TIMEOUT_MS,
  getConcurrencyLimitActiveJobsCount,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "./concurrency-redis";
import {
  MAX_BACKLOG_TIMEOUT_MS,
  constructConcurrencyLimitKey,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
} from "./concurrency-redis";
import { reportPipelineError } from "./redis-pipeline";
import { jobContext, storedZeroDataRetention } from "./request-context";
import type { JobKind } from "../service/hooks";
import type { RequestContext } from "../service/request-context";
import { installedService } from "../service/service";
import type { ScrapeJobData } from "../types";
import { currentLimits } from "./limits";
import { recordCrawlStateMissing } from "./crawl-state-metrics";
import { jsonObjectSchema } from "./json-types";

interface JobEnqueuedEvent {
  jobId: string;
  kind: JobKind;
  ctx: RequestContext;
  url?: string;
  jobData: ScrapeJobData;
}

function scrapeJobKind(data: ScrapeJobData): JobKind {
  if (data.mode === "kickoff" || data.mode === "kickoff_sitemap") {
    return "crawl";
  }
  if (data.crawl_id) {
    return data.crawlerOptions !== null && data.crawlerOptions !== undefined
      ? "crawl"
      : "batchScrape";
  }
  return "scrape";
}

/** Emits `job.enqueued` when a handler is registered on the active service. */
export function observeJobEnqueued(jobId: string, data: ScrapeJobData): void {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("job.enqueued")) {
    return;
  }
  const event: JobEnqueuedEvent = {
    jobId,
    kind: scrapeJobKind(data),
    ctx: jobContext(data),
    jobData: data,
  };
  if (data.mode === "single_urls") {
    event.url = data.url;
  }
  hooks.observe("job.enqueued", event);
}

const constructKey = constructConcurrencyLimitKey;
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

export async function getConcurrencyLimitActiveJobs(
  team_id: string,
  now: number = Date.now(),
): Promise<Array<string>> {
  return await getRedisConnection().zrangebyscore(
    constructKey(team_id),
    now,
    Infinity,
  );
}

export async function removeConcurrencyLimitedJobs(
  team_id: string,
  job_ids: Array<string>,
) {
  if (job_ids.length === 0) {
    return;
  }
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

const scrapeJobCommonFields = {
  team_id: z.string(),
  zeroDataRetention: z.boolean().nullish(),
  origin: z.string().nullish(),
  apiKeyId: z.number().nullish(),
};

const scrapeJobDataSchema = z.discriminatedUnion("mode", [
  z.object({
    ...scrapeJobCommonFields,
    mode: z.literal("single_urls"),
    url: z.string(),
    scrapeOptions: jsonObjectSchema.nullish(),
    crawl_id: z.string().nullish(),
    crawlerOptions: jsonObjectSchema.nullish(),
  }),
  z.object({
    ...scrapeJobCommonFields,
    mode: z.literal("kickoff"),
    url: z.string(),
    crawl_id: z.string(),
    scrapeOptions: jsonObjectSchema.nullish(),
    v1: z.boolean().nullish(),
    crawlerOptions: jsonObjectSchema.nullish(),
  }),
  z.object({
    ...scrapeJobCommonFields,
    mode: z.literal("kickoff_sitemap"),
    crawl_id: z.string(),
    sitemapUrl: z.string(),
    v1: z.boolean().nullish(),
  }),
]);

const concurrencyLimitedJobSchema = z.object({
  id: z.string(),
  priority: z
    .number()
    .nullish()
    .transform(value => value ?? 0),
  listenable: z
    .boolean()
    .nullish()
    .transform(value => value ?? false),
  data: z.custom<ScrapeJobData>(
    value => scrapeJobDataSchema.safeParse(value).success,
  ),
});

type ConcurrencyLimitedJob = z.infer<typeof concurrencyLimitedJobSchema>;

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
  jobs: Array<{ job: ConcurrencyLimitedJob; timeout: number }>,
  now: number = Date.now(),
) {
  if (jobs.length === 0) {
    return;
  }

  const queueKey = constructQueueKey(team_id);
  const redis = getRedisConnection();
  const pipeline = redis.pipeline();
  const zaddArgs: Array<string | number> = [];

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
): Promise<Array<string>> {
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

function parseCrawlDelay(rawDelay: unknown): number | undefined {
  if (typeof rawDelay === "number") {
    return Number.isFinite(rawDelay) ? rawDelay : undefined;
  }
  if (typeof rawDelay === "string") {
    const trimmed = rawDelay.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
  const crawlCache = new Map<string, StoredCrawl | null>();
  const queueKey = constructQueueKey(teamId);
  const redis = getRedisConnection();
  const now = Date.now();

  // Jobs we popped but can't run due to crawl concurrency limits.
  // We'll re-add them at the end so other callers can try them later.
  const crawlBlocked: Array<{
    member: string;
    score: number;
    jobData: string;
  }> = [];

  try {
    while (true) {
      // ZPOPMIN atomically removes and returns the lowest-scored member.
      // No two workers can ever get the same entry.
      const result = await redis.zpopmin(queueKey);
      if (!result || result.length < 2) {
        return null;
      }

      const [member, scoreStr] = result;
      const score = Number.parseFloat(scoreStr);

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

      let parsedJob: unknown;
      try {
        parsedJob = JSON.parse(jobData);
      } catch {
        await redis.del(constructJobKey(member));
        continue;
      }
      const validated = concurrencyLimitedJobSchema.safeParse(parsedJob);
      if (!validated.success) {
        const parsedDataHolder = z
          .object({ data: z.unknown() })
          .safeParse(parsedJob);
        const topZdr = storedZeroDataRetention(parsedJob);
        const nestedZdr = parsedDataHolder.success
          ? storedZeroDataRetention(parsedDataHolder.data.data)
          : undefined;
        const isZdr = topZdr === true || nestedZdr === true;
        const knownNonZdr = topZdr === false || nestedZdr === false;
        logger.warn(
          "Dropping invalid concurrency-limited job payload",
          isZdr
            ? {
                module: "concurrency-limit",
                teamId,
                jobId: member,
                zeroDataRetention: true,
                issues: validated.error.issues,
              }
            : knownNonZdr
              ? {
                  module: "concurrency-limit",
                  teamId,
                  jobId: member,
                  zeroDataRetention: false,
                  issues: validated.error.issues,
                }
              : {
                  module: "concurrency-limit",
                  issues: validated.error.issues,
                },
        );
        await redis.del(constructJobKey(member));
        continue;
      }
      const job = validated.data;

      // Check crawl concurrency limit
      if (job.data.crawl_id) {
        let sc = crawlCache.get(job.data.crawl_id);
        if (sc === undefined) {
          sc = await getCrawl(job.data.crawl_id);
          crawlCache.set(job.data.crawl_id, sc);
          // A missing crawl document gets the strictest crawl cap, never none.
          if (sc === null) {
            recordCrawlStateMissing("gate", job.data.crawl_id, logger, {
              teamId,
              jobId: job.id,
            });
          }
        }
        const delay = parseCrawlDelay(sc?.crawlerOptions?.delay);
        const maxCrawlConcurrency =
          sc === null
            ? 1
            : delay !== undefined && delay > 0
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
        zeroDataRetention: storedZeroDataRetention(job.data),
      });
      return { job, timeout: Infinity };
    }
  } finally {
    // Re-add crawl-blocked jobs so they can be picked up later
    if (crawlBlocked.length > 0) {
      const zaddArgs: Array<string | number> = [];
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
export async function concurrentJobDone(job: NuQJob<ScrapeJobData>) {
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

    // Once per call, not once per job promoted below. Skip promotion if lookup fails
    // so a transient limits error is never treated as an unlimited cap.
    let maxTeamConcurrency: number | null;
    try {
      maxTeamConcurrency = await currentLimits().teamConcurrency(
        job.data.team_id,
      );
    } catch (error: unknown) {
      logger.warn(
        "Failed to resolve team concurrency limit during job completion, skipping backlog promotion",
        { teamId: job.data.team_id, error },
      );
      return;
    }

    let staleSkipped = 0;
    while (staleSkipped < 100) {
      if (maxTeamConcurrency !== null) {
        const currentActiveConcurrency = (
          await getConcurrencyLimitActiveJobs(job.data.team_id)
        ).length;

        if (currentActiveConcurrency >= maxTeamConcurrency) {
          break;
        }
      }

      const nextJob = await getNextConcurrentJob(job.data.team_id);
      if (nextJob === null) {
        break;
      }

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
        const delay = parseCrawlDelay(sc?.crawlerOptions?.delay);
        if (delay !== undefined) {
          await new Promise<void>(resolve => {
            setTimeout(resolve, delay * 1000);
          });
        }
      }

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
        observeJobEnqueued(nextJob.job.id, nextJob.job.data);
        logger.debug("Successfully promoted concurrent queued job", {
          teamId: job.data.team_id,
          jobId: nextJob.job.id,
          zeroDataRetention: storedZeroDataRetention(nextJob.job.data),
        });
        break;
      } else {
        logger.warn(
          "Was unable to promote concurrent queued job as it already exists in the database",
          {
            teamId: job.data.team_id,
            jobId: nextJob.job.id,
            zeroDataRetention: storedZeroDataRetention(nextJob.job.data),
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
