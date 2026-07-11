import { v7 as uuidv7 } from "uuid";
import { NotificationType, RateLimiterMode, ScrapeJobData } from "../types";
import {
  cleanOldConcurrencyLimitEntries,
  getCrawlConcurrencyLimitActiveJobs,
  getTeamQueueLimit,
  MAX_BACKLOG_TIMEOUT_MS,
  pushConcurrencyLimitedJob,
  pushConcurrencyLimitedJobs,
  removeConcurrencyLimitedJobs,
  QueueFullError,
} from "../lib/concurrency-limit";
import { logger as _logger } from "../lib/logger";
import { sendNotificationWithCustomDays } from "./notification/email_notification";
import { shouldSendConcurrencyLimitNotification } from "./notification/notification-check";
import { getACUCTeam } from "../controllers/auth";
import { getJobFromGCS, removeJobFromGCS } from "../lib/gcs-jobs";
import { Document } from "../controllers/v1/types";
import { getCrawl } from "../lib/crawl-redis";
import { Logger } from "winston";
import { ScrapeJobTimeoutError, TransportableError } from "../lib/error";
import { deserializeTransportableError } from "../lib/error-serde";
import { abTestJob } from "./ab-test";
import { NuQJob, NuQPublicationConflictError, scrapeQueue } from "./worker/nuq";
import {
  fdbEnqueueScrapeJobs,
  getCombinedTeamActiveCount,
  getCombinedTeamPendingCount,
  resolveJobBackend,
  withTeamMigrationAdmission,
  scrapeQueue as routedScrapeQueue,
  type QueueBackend,
} from "./worker/nuq-router";
import {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "./worker/nuq-fdb";
import { serializeTraceContext } from "../lib/otel-tracer";
import { isSelfHosted } from "../lib/deployment";
import { MONITOR_CHECK_STALE_TIMEOUT_MS } from "./monitoring/stale";
import { getRedisConnection } from "./queue-service";
import { NuQRouterBothBackendsError } from "./worker/nuq-migration-control";
import {
  completePreparedNuQPgPublication,
  completePreparedNuQPgPublicationSubset,
  prepareNuQPgPublication,
  type NuQPgPublication,
} from "./worker/nuq-pg-publication";

// Queue-wait deadline for a backlogged job (how long its owner still cares about the result)
function backlogTimeoutMs(data: ScrapeJobData): number {
  if (data.crawl_id) return MAX_BACKLOG_TIMEOUT_MS;
  if (data.monitoring) return MONITOR_CHECK_STALE_TIMEOUT_MS;
  if (data.mode === "single_urls")
    return data.scrapeOptions.timeout ?? 60 * 1000;
  return 60 * 1000;
}

/**
 * Checks if a job is a crawl or batch scrape based on its options
 * @param options The job options containing crawlerOptions and crawl_id
 * @returns true if the job is either a crawl or batch scrape
 */
function isCrawlOrBatchScrape(options: {
  crawlerOptions?: any;
  crawl_id?: string;
}): boolean {
  // If crawlerOptions exists, it's a crawl
  // If crawl_id exists but no crawlerOptions, it's a batch scrape
  return !!options.crawlerOptions || !!options.crawl_id;
}

function pgPublication(
  jobId: string,
  data: ScrapeJobData,
  placement: "active" | "backlog",
): NuQPgPublication {
  return {
    id: jobId,
    ownerId: data.team_id,
    groupId: data.crawl_id,
    placement,
  };
}

async function compensateAmbiguousBacklogRedisPublication(
  publications: readonly NuQPgPublication[],
): Promise<void> {
  const byOwner = new Map<string, string[]>();
  for (const publication of publications) {
    const ids = byOwner.get(publication.ownerId) ?? [];
    ids.push(publication.id);
    byOwner.set(publication.ownerId, ids);
  }
  // PG is authoritative once inserted. Normalize an ambiguous Redis outcome
  // to DB-only and leave the prepared generation intent unresolved; the
  // reconciler republishes cq-job + ZSET and then completes the intent.
  for (const [ownerId, ids] of byOwner) {
    await removeConcurrencyLimitedJobs(ownerId, ids);
  }
}

type ReservationOwnership = {
  zsetKey: string;
  markerKey: string;
  jobId: string;
  token: string;
  previousScore: string | null;
  reservedScore: string;
};

type ActiveReservation = {
  jobId: string;
  data: ScrapeJobData;
  ownerships: ReservationOwnership[];
};

class PgCapacityReservationDeniedError extends Error {}

async function acquireActiveReservation(
  zsetKey: string,
  markerKey: string,
  jobId: string,
  limit: number | null,
): Promise<ReservationOwnership | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const reservedScore = String(now + 60 * 1000);
  const result = (await getRedisConnection().eval(
    `local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
     if redis.call('EXISTS', KEYS[2]) == 1 then
       return {2, current or '', ''}
     end
     if current and tonumber(current) > tonumber(ARGV[2]) then
       return {0, current, ''}
     end
     if not current and tonumber(ARGV[6]) >= 0 and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[6]) then
       return {3, '', ''}
     end
     redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
     redis.call('SET', KEYS[2], cjson.encode({token=ARGV[4], previous=current or '', reserved=ARGV[3]}), 'PX', ARGV[5])
     return {1, current or '', ARGV[3]}`,
    2,
    zsetKey,
    markerKey,
    jobId,
    now,
    reservedScore,
    token,
    2 * 60 * 1000,
    limit ?? -1,
  )) as [number, string, string];
  const status = Number(result[0]);
  if (status === 3) throw new PgCapacityReservationDeniedError();
  if (status === 2) {
    throw new Error(`PG active reservation is already pending for ${jobId}`);
  }
  if (status !== 1) return null;
  return {
    zsetKey,
    markerKey,
    jobId,
    token,
    previousScore: result[1] || null,
    reservedScore: result[2],
  };
}

async function rollbackReservationOwnership(
  ownership: ReservationOwnership,
): Promise<void> {
  await getRedisConnection().eval(
    `local raw = redis.call('GET', KEYS[2])
     if not raw then return 0 end
     local marker = cjson.decode(raw)
     if marker.token ~= ARGV[2] then return 0 end
     local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
     if current and current == ARGV[3] then
       if ARGV[4] == '' then
         redis.call('ZREM', KEYS[1], ARGV[1])
       else
         redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
       end
     end
     redis.call('DEL', KEYS[2])
     return 1`,
    2,
    ownership.zsetKey,
    ownership.markerKey,
    ownership.jobId,
    ownership.token,
    ownership.reservedScore,
    ownership.previousScore ?? "",
  );
}

async function rollbackActiveReservations(
  reservations: readonly ActiveReservation[],
): Promise<void> {
  const results = await Promise.allSettled(
    reservations.flatMap(reservation =>
      reservation.ownerships.map(rollbackReservationOwnership),
    ),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(failure => failure.reason),
      "Failed to restore PG queue reservations",
    );
  }
}

async function commitActiveReservations(
  reservations: readonly ActiveReservation[],
): Promise<void> {
  const redis = getRedisConnection();
  await Promise.all(
    reservations.flatMap(reservation =>
      reservation.ownerships.map(ownership =>
        redis.eval(
          `local raw = redis.call('GET', KEYS[1])
           if not raw then return 0 end
           local marker = cjson.decode(raw)
           if marker.token == ARGV[1] then return redis.call('DEL', KEYS[1]) end
           return 0`,
          1,
          ownership.markerKey,
          ownership.token,
        ),
      ),
    ),
  );
}

async function reserveActiveJob(
  jobId: string,
  data: ScrapeJobData,
  teamLimit: number | null,
): Promise<ActiveReservation> {
  const reservation: ActiveReservation = { jobId, data, ownerships: [] };
  try {
    const teamOwnership = await acquireActiveReservation(
      `concurrency-limiter:${data.team_id}`,
      `nuq:pg-reservation:team:${data.team_id}:${jobId}`,
      jobId,
      teamLimit,
    );
    if (teamOwnership) reservation.ownerships.push(teamOwnership);
    if (data.crawl_id) {
      const sc = await getCrawl(data.crawl_id);
      if (sc?.crawlerOptions?.delay || sc?.maxConcurrency) {
        const crawlOwnership = await acquireActiveReservation(
          `crawl-concurrency-limiter:${data.crawl_id}`,
          `nuq:pg-reservation:crawl:${data.crawl_id}:${jobId}`,
          jobId,
          sc.maxConcurrency ?? 1,
        );
        if (crawlOwnership) reservation.ownerships.push(crawlOwnership);
      }
    }
    return reservation;
  } catch (error) {
    await rollbackActiveReservations([reservation]);
    throw error;
  }
}

async function _addScrapeJobToConcurrencyQueue(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
) {
  const publication = pgPublication(jobId, webScraperOptions, "backlog");
  const prepared = await prepareNuQPgPublication([publication]);
  let inserted = false;
  try {
    const result = await scrapeQueue.addJobWithPublicationState(
      jobId,
      {
        ...webScraperOptions,
        concurrencyLimited: true,
      },
      {
        priority,
        listenable,
        ownerId: webScraperOptions.team_id ?? undefined,
        groupId: webScraperOptions.crawl_id ?? undefined,
        backlogged: true,
        backloggedTimesOutAt: new Date(
          Date.now() + backlogTimeoutMs(webScraperOptions),
        ),
      },
    );
    inserted = result.inserted;
    if (result.job.status !== "backlog") {
      await completePreparedNuQPgPublication(prepared);
      return;
    }
    const authoritativeTimeout = result.job.backloggedTimesOutAt
      ? Math.max(1, result.job.backloggedTimesOutAt.valueOf() - Date.now())
      : backlogTimeoutMs(webScraperOptions);

    await pushConcurrencyLimitedJob(
      webScraperOptions.team_id,
      {
        id: jobId,
        data: webScraperOptions,
        priority,
        listenable,
      },
      authoritativeTimeout,
    );
  } catch (error) {
    if (error instanceof NuQPublicationConflictError) {
      await completePreparedNuQPgPublication(prepared, "compensated");
      throw error;
    }
    try {
      let materialized = inserted;
      if (!materialized) {
        const [active, backlog] = await Promise.all([
          scrapeQueue.getJob(jobId),
          scrapeQueue.getJobsFromBacklog([jobId]),
        ]);
        materialized = active !== null || backlog.length > 0;
      }
      if (materialized) {
        await compensateAmbiguousBacklogRedisPublication([publication]);
      } else {
        await completePreparedNuQPgPublication(prepared, "compensated");
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PG backlog publication and compensation both failed",
      );
    }
    throw error;
  }
  await completePreparedNuQPgPublication(prepared);
}

async function _addScrapeJobsToConcurrencyQueue(
  jobs: {
    data: ScrapeJobData;
    jobId: string;
    priority: number;
    listenable?: boolean;
  }[],
) {
  const publications = jobs.map(job =>
    pgPublication(job.jobId, job.data, "backlog"),
  );
  const prepared = await prepareNuQPgPublication(publications);
  let insertedIds = new Set<string>();
  try {
    const publicationResult = await scrapeQueue.addJobsWithPublicationState(
      jobs.map(job => ({
        id: job.jobId,
        data: job.data,
        options: {
          priority: job.priority,
          listenable: job.listenable ?? false,
          ownerId: job.data.team_id ?? undefined,
          groupId: job.data.crawl_id ?? undefined,
          backlogged: true,
          backloggedTimesOutAt: new Date(
            Date.now() + backlogTimeoutMs(job.data),
          ),
        },
      })),
    );
    insertedIds = publicationResult.insertedIds;
    const publishedById = new Map(
      publicationResult.jobs.map(job => [job.id, job]),
    );

    const jobsByTeam = new Map<
      string,
      {
        job: {
          id: string;
          data: ScrapeJobData;
          priority: number;
          listenable: boolean;
        };
        timeout: number;
      }[]
    >();

    for (const job of jobs) {
      if (publishedById.get(job.jobId.toLowerCase())?.status !== "backlog") {
        continue;
      }
      const teamJobs = jobsByTeam.get(job.data.team_id) ?? [];
      teamJobs.push({
        job: {
          id: job.jobId,
          data: job.data,
          priority: job.priority,
          listenable: job.listenable ?? false,
        },
        timeout: publishedById.get(job.jobId.toLowerCase())
          ?.backloggedTimesOutAt
          ? Math.max(
              1,
              publishedById
                .get(job.jobId.toLowerCase())!
                .backloggedTimesOutAt!.valueOf() - Date.now(),
            )
          : backlogTimeoutMs(job.data),
      });
      jobsByTeam.set(job.data.team_id, teamJobs);
    }

    for (const [teamId, teamJobs] of jobsByTeam) {
      await pushConcurrencyLimitedJobs(teamId, teamJobs);
    }
  } catch (error) {
    if (error instanceof NuQPublicationConflictError) {
      await completePreparedNuQPgPublication(prepared, "compensated");
      throw error;
    }
    try {
      const ids = publications.map(publication => publication.id);
      const [active, backlog] = await Promise.all([
        scrapeQueue.getJobs(ids),
        scrapeQueue.getJobsFromBacklog(ids),
      ]);
      for (const job of [...active, ...backlog]) insertedIds.add(job.id);
      const insertedPublications = publications.filter(publication =>
        insertedIds.has(publication.id.toLowerCase()),
      );
      if (insertedPublications.length > 0) {
        await compensateAmbiguousBacklogRedisPublication(insertedPublications);
      }
      await completePreparedNuQPgPublicationSubset(
        prepared,
        publications.filter(
          publication => !insertedIds.has(publication.id.toLowerCase()),
        ),
        "compensated",
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Bulk PG backlog publication and compensation both failed",
      );
    }
    throw error;
  }
  await completePreparedNuQPgPublication(prepared);
}

export async function _addScrapeJobToBullMQ(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData>> {
  return await withTeamMigrationAdmission(
    webScraperOptions.team_id,
    async () => {
      // Direct/kickoff adds bypass the queue gate. The FDB core deliberately
      // gives bypass jobs no slot; the PG path retains its legacy reservation.
      if ((await resolveJobBackend(webScraperOptions)) === "fdb") {
        if (webScraperOptions.mode === "single_urls") {
          abTestJob(webScraperOptions);
        }
        const { jobs } = await fdbEnqueueScrapeJobs(
          [
            {
              jobId,
              data: webScraperOptions,
              priority,
              listenable,
              backlogTimeoutMs: backlogTimeoutMs(webScraperOptions),
            },
          ],
          webScraperOptions.team_id,
          { bypassGate: true },
        );
        return jobs[0];
      }

      return _addScrapeJobToBullMQPg(
        webScraperOptions,
        jobId,
        priority,
        listenable,
      );
    },
  );
}

async function _addScrapeJobToBullMQPg(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
  teamLimit: number | null = null,
): Promise<NuQJob<ScrapeJobData>> {
  if (webScraperOptions.mode === "single_urls") {
    abTestJob(webScraperOptions);
  }

  const publication = pgPublication(jobId, webScraperOptions, "active");
  const prepared = await prepareNuQPgPublication([publication]);
  const reserved: ActiveReservation[] = [];
  try {
    reserved.push(await reserveActiveJob(jobId, webScraperOptions, teamLimit));

    const job = await scrapeQueue.addJob(jobId, webScraperOptions, {
      priority,
      listenable,
      ownerId: webScraperOptions.team_id ?? undefined,
      groupId: webScraperOptions.crawl_id ?? undefined,
    });
    if (job.status === "completed" || job.status === "failed") {
      await rollbackActiveReservations(reserved);
    }
    await completePreparedNuQPgPublication(prepared);
    await commitActiveReservations(reserved);
    return job;
  } catch (error) {
    if (error instanceof PgCapacityReservationDeniedError) {
      await rollbackActiveReservations(reserved);
      // Preserve the prepared generation intent: the caller republishes the
      // same stable id into the PG backlog after losing atomic admission.
      throw error;
    }
    if (error instanceof NuQPublicationConflictError) {
      await rollbackActiveReservations(reserved);
      await completePreparedNuQPgPublication(prepared, "compensated");
      throw error;
    }
    // Once PG has succeeded, a generation-complete failure must remain
    // unresolved and published for reconciliation; do not tear it down.
    let existing: NuQJob<ScrapeJobData> | null;
    try {
      existing = await scrapeQueue.getJob(jobId);
    } catch {
      // Probe unavailable: preserve reservations for a possibly committed row.
      throw error;
    }
    if (!existing) {
      try {
        await rollbackActiveReservations(reserved);
        await completePreparedNuQPgPublication(prepared, "compensated");
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "PG active publication and reservation rollback both failed",
        );
      }
    }
    throw error;
  }
}

async function _addScrapeJobsToBullMQ(
  jobs: {
    data: ScrapeJobData;
    jobId: string;
    priority: number;
    listenable?: boolean;
  }[],
  teamLimit: number | null = null,
): Promise<NuQJob<ScrapeJobData>[]> {
  for (const job of jobs) {
    if (job.data.mode === "single_urls") abTestJob(job.data);
  }

  const publications = jobs.map(job =>
    pgPublication(job.jobId, job.data, "active"),
  );
  const prepared = await prepareNuQPgPublication(publications);
  const reserved: ActiveReservation[] = [];
  try {
    for (const job of jobs) {
      reserved.push(await reserveActiveJob(job.jobId, job.data, teamLimit));
    }

    const result = await scrapeQueue.addJobs(
      jobs.map(job => ({
        id: job.jobId,
        data: job.data,
        options: {
          priority: job.priority,
          listenable: job.listenable ?? false,
          ownerId: job.data.team_id ?? undefined,
          groupId: job.data.crawl_id ?? undefined,
        },
      })),
    );
    const terminalIds = new Set(
      result
        .filter(job => job.status === "completed" || job.status === "failed")
        .map(job => job.id),
    );
    await rollbackActiveReservations(
      reserved.filter(job => terminalIds.has(job.jobId.toLowerCase())),
    );
    await completePreparedNuQPgPublication(prepared);
    await commitActiveReservations(reserved);
    return result;
  } catch (error) {
    if (error instanceof PgCapacityReservationDeniedError) {
      await rollbackActiveReservations(reserved);
      // Preserve prepared intents for atomic fallback of the whole candidate
      // partition into backlog placement.
      throw error;
    }
    if (error instanceof NuQPublicationConflictError) {
      await rollbackActiveReservations(reserved);
      await completePreparedNuQPgPublication(prepared, "compensated");
      throw error;
    }
    let existingJobs: NuQJob<ScrapeJobData>[];
    try {
      existingJobs = await scrapeQueue.getJobs(jobs.map(job => job.jobId));
    } catch {
      // Probe unavailable: preserve reservations for possibly committed rows.
      throw error;
    }
    const materialized = new Set(existingJobs.map(job => job.id));
    const safeToRelease = reserved.filter(
      job => !materialized.has(job.jobId.toLowerCase()),
    );
    try {
      await rollbackActiveReservations(safeToRelease);
      await completePreparedNuQPgPublicationSubset(
        prepared,
        publications.filter(
          publication => !materialized.has(publication.id.toLowerCase()),
        ),
        "compensated",
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Bulk PG active publication and reservation rollback both failed",
      );
    }
    throw error;
  }
}

async function addScrapeJobFdb(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number,
  directToBullMQ: boolean,
  listenable: boolean,
): Promise<NuQJob<ScrapeJobData> | null> {
  if (webScraperOptions.mode === "single_urls") {
    abTestJob(webScraperOptions);
  }

  const { jobs, backloggedCount, teamLimit } = await fdbEnqueueScrapeJobs(
    [
      {
        jobId,
        data: webScraperOptions,
        priority,
        listenable,
        backlogTimeoutMs: backlogTimeoutMs(webScraperOptions),
      },
    ],
    webScraperOptions.team_id,
    { bypassGate: directToBullMQ },
  );

  if (backloggedCount > 0) {
    await maybeSendConcurrencyNotificationFdb(
      webScraperOptions.team_id,
      teamLimit,
      isCrawlOrBatchScrape(webScraperOptions),
    );
    // matches the PG contract: null = job waiting in the concurrency queue
    return null;
  }
  return jobs[0];
}

// parity with the PG path: notify when the backlog exceeds the team limit
const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;

async function maybeSendConcurrencyNotificationFdb(
  teamId: string,
  teamLimit: number | null,
  crawlOrBatch: boolean,
) {
  if (teamLimit === null || crawlOrBatch) return;
  try {
    if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_COUNT_TIMEOUT_MS))) return;
    const pending = await withFdbTimeout(
      scrapeQueueFdb.getTeamPendingCount(teamId),
      FDB_OPTIONAL_COUNT_TIMEOUT_MS,
    );
    if (pending <= teamLimit) return;
    const shouldSendNotification =
      await shouldSendConcurrencyLimitNotification(teamId);
    if (shouldSendNotification) {
      sendNotificationWithCustomDays(
        teamId,
        NotificationType.CONCURRENCY_LIMIT_REACHED,
        15,
        false,
        true,
      ).catch(error => {
        _logger.error(
          "Error sending notification (concurrency limit reached)",
          {
            error,
          },
        );
      });
    }
  } catch (error) {
    _logger.warn("Failed to check FDB concurrency notification", { error });
  }
}

async function addScrapeJobRaw(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  directToBullMQ: boolean = false,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData> | null> {
  if ((await resolveJobBackend(webScraperOptions)) === "fdb") {
    return addScrapeJobFdb(
      webScraperOptions,
      jobId,
      priority,
      directToBullMQ,
      listenable,
    );
  }

  let concurrencyLimited: "yes" | "yes-crawl" | "no" | null = null;
  let currentActiveConcurrency: number | null = null;
  let maxConcurrency = 0;
  let currentCrawlConcurrency: number | null = null;
  let maxCrawlConcurrency: number | null = null;

  // Bypass concurrency limits for self-hosted deployments
  if (isSelfHosted()) {
    concurrencyLimited = "no";
  } else if (directToBullMQ) {
    concurrencyLimited = "no";
  } else {
    if (webScraperOptions.crawl_id) {
      const crawl = await getCrawl(webScraperOptions.crawl_id);
      const concurrencyLimit = !crawl
        ? null
        : crawl.crawlerOptions?.delay === undefined &&
            crawl.maxConcurrency === undefined
          ? null
          : (crawl.maxConcurrency ?? 1);

      if (concurrencyLimit !== null) {
        maxCrawlConcurrency = concurrencyLimit;
        currentCrawlConcurrency = (
          await getCrawlConcurrencyLimitActiveJobs(webScraperOptions.crawl_id)
        ).length;
        const freeSlots = Math.max(
          concurrencyLimit - currentCrawlConcurrency,
          0,
        );
        if (freeSlots === 0) {
          concurrencyLimited = "yes-crawl";
        }
      }
    }

    maxConcurrency =
      (
        await getACUCTeam(
          webScraperOptions.team_id,
          false,
          true,
          RateLimiterMode.Crawl,
        )
      )?.concurrency ?? 2;

    if (concurrencyLimited === null) {
      const now = Date.now();
      await cleanOldConcurrencyLimitEntries(webScraperOptions.team_id, now);
      currentActiveConcurrency = await getCombinedTeamActiveCount(
        webScraperOptions.team_id,
      );
      concurrencyLimited =
        currentActiveConcurrency >= maxConcurrency ? "yes" : "no";
    }
  }

  if (concurrencyLimited === "yes" || concurrencyLimited === "yes-crawl") {
    const concurrencyQueueJobs = await getCombinedTeamPendingCount(
      webScraperOptions.team_id,
    );

    const queueLimit = getTeamQueueLimit(maxConcurrency);
    if (concurrencyQueueJobs >= queueLimit) {
      throw new QueueFullError(concurrencyQueueJobs, queueLimit);
    }

    if (currentActiveConcurrency === null) {
      const now = Date.now();
      await cleanOldConcurrencyLimitEntries(webScraperOptions.team_id, now);
      currentActiveConcurrency = await getCombinedTeamActiveCount(
        webScraperOptions.team_id,
      );
    }

    _logger.info("Adding scrape job to concurrency queue", {
      teamId: webScraperOptions.team_id,
      concurrencyLimitReason:
        concurrencyLimited === "yes-crawl" ? "crawl" : "team",
      maxConcurrency,
      currentConcurrency: currentActiveConcurrency,
      crawlId: webScraperOptions.crawl_id,
      maxCrawlConcurrency,
      currentCrawlConcurrency,
      jobId,
    });

    if (concurrencyLimited === "yes") {
      // Detect if they hit their concurrent limit
      // If above by 2x, send them an email
      // No need to 2x as if there are more than the max concurrency in the concurrency queue, it is already 2x
      if (concurrencyQueueJobs > maxConcurrency) {
        // logger.info("Concurrency limited 2x (single) - ", "Concurrency queue jobs: ", concurrencyQueueJobs, "Max concurrency: ", maxConcurrency, "Team ID: ", webScraperOptions.team_id);

        // Only send notification if it's not a crawl or batch scrape
        const shouldSendNotification =
          await shouldSendConcurrencyLimitNotification(
            webScraperOptions.team_id,
          );
        if (shouldSendNotification) {
          sendNotificationWithCustomDays(
            webScraperOptions.team_id,
            NotificationType.CONCURRENCY_LIMIT_REACHED,
            15,
            false,
            true,
          ).catch(error => {
            _logger.error(
              "Error sending notification (concurrency limit reached)",
              { error },
            );
          });
        }
      }
    }

    webScraperOptions.concurrencyLimited = true;

    await _addScrapeJobToConcurrencyQueue(
      webScraperOptions,
      jobId,
      priority,
      listenable,
    );
    return null;
  } else {
    try {
      return await _addScrapeJobToBullMQPg(
        webScraperOptions,
        jobId,
        priority,
        listenable,
        !isSelfHosted() && !directToBullMQ ? maxConcurrency : null,
      );
    } catch (error) {
      if (!(error instanceof PgCapacityReservationDeniedError)) throw error;
      const pending = await getCombinedTeamPendingCount(
        webScraperOptions.team_id,
      );
      const queueLimit = getTeamQueueLimit(maxConcurrency);
      if (pending >= queueLimit) throw new QueueFullError(pending, queueLimit);
      webScraperOptions.concurrencyLimited = true;
      await _addScrapeJobToConcurrencyQueue(
        webScraperOptions,
        jobId,
        priority,
        listenable,
      );
      return null;
    }
  }
}

export async function addScrapeJob(
  webScraperOptions: ScrapeJobData,
  jobId: string = uuidv7(),
  priority: number = 0,
  directToBullMQ: boolean = false,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData> | null> {
  // Capture trace context to propagate to worker
  const traceContext = serializeTraceContext();
  const optionsWithTrace: ScrapeJobData = {
    ...webScraperOptions,
    traceContext,
  };

  return await withTeamMigrationAdmission(
    optionsWithTrace.team_id,
    async () =>
      await addScrapeJobRaw(
        optionsWithTrace,
        jobId,
        priority,
        directToBullMQ,
        listenable,
      ),
  );
}

async function preflightPgPartition(
  teamId: string,
  jobs: { data: ScrapeJobData }[],
): Promise<void> {
  if (jobs.length === 0 || isSelfHosted()) return;
  const maxConcurrency =
    (await getACUCTeam(teamId, false, true, RateLimiterMode.Scrape))
      ?.concurrency ?? 2;
  const active = await getCombinedTeamActiveCount(teamId);
  const newlyPending = Math.max(
    0,
    jobs.length - Math.max(0, maxConcurrency - active),
  );
  if (newlyPending === 0) return;
  const pending = await getCombinedTeamPendingCount(teamId);
  const queueLimit = getTeamQueueLimit(maxConcurrency);
  if (pending + newlyPending > queueLimit) {
    throw new QueueFullError(pending, queueLimit);
  }
}

export async function addScrapeJobs(
  jobs: {
    jobId: string;
    data: ScrapeJobData;
    priority: number;
    listenable?: boolean;
  }[],
) {
  if (jobs.length === 0) return true;

  // Capture trace context for all jobs
  const traceContext = serializeTraceContext();

  const jobsByTeam = new Map<
    string,
    {
      jobId: string;
      data: ScrapeJobData;
      priority: number;
      listenable?: boolean;
    }[]
  >();

  for (const job of jobs) {
    if (!jobsByTeam.has(job.data.team_id)) {
      jobsByTeam.set(job.data.team_id, []);
    }
    jobsByTeam.get(job.data.team_id)!.push(job);
  }

  for (const [teamId, allTeamJobs] of jobsByTeam) {
    await withTeamMigrationAdmission(teamId, async () => {
      // jobs can split across backends mid-migration (old crawls drain on PG
      // while the team's new crawls run on FDB); partition by job backend
      const backendByJob = new Map<string, "pg" | "fdb">();
      const backendByCrawl = new Map<string, "pg" | "fdb">();
      for (const job of allTeamJobs) {
        const crawlId = job.data.crawl_id;
        if (crawlId && backendByCrawl.has(crawlId)) {
          backendByJob.set(job.jobId, backendByCrawl.get(crawlId)!);
          continue;
        }
        const backend = await resolveJobBackend(job.data);
        backendByJob.set(job.jobId, backend);
        if (crawlId) backendByCrawl.set(crawlId, backend);
      }

      const fdbJobs = allTeamJobs.filter(
        j => backendByJob.get(j.jobId) === "fdb",
      );
      const pgJobs = allTeamJobs.filter(
        j => backendByJob.get(j.jobId) === "pg",
      );
      // Pause/drain never publishes one batch into both ledgers. Mixed pins
      // indicate corrupt or incompletely migrated source state and must fail
      // before either backend commits.
      if (fdbJobs.length > 0 && pgJobs.length > 0) {
        throw new NuQRouterBothBackendsError("team_batch", teamId);
      }
      await preflightPgPartition(teamId, pgJobs);
      if (fdbJobs.length > 0) {
        const { backloggedCount, teamLimit } = await fdbEnqueueScrapeJobs(
          fdbJobs.map(job => ({
            jobId: job.jobId,
            data: { ...job.data, traceContext },
            priority: job.priority,
            listenable: job.listenable,
            backlogTimeoutMs: backlogTimeoutMs(job.data),
          })),
          teamId,
        );
        if (backloggedCount > 0) {
          await maybeSendConcurrencyNotificationFdb(
            teamId,
            teamLimit,
            isCrawlOrBatchScrape(fdbJobs[0].data),
          );
        }
      }

      const teamJobs = pgJobs;
      if (teamJobs.length === 0) return;
      // == Buckets for jobs ==
      let jobsForcedToCQ: {
        data: ScrapeJobData;
        jobId: string;
        priority: number;
        listenable?: boolean;
      }[] = [];

      let jobsPotentiallyInCQ: {
        data: ScrapeJobData;
        jobId: string;
        priority: number;
        listenable?: boolean;
      }[] = [];

      // == Select jobs by crawl ID ==
      const jobsByCrawlID = new Map<
        string,
        {
          data: ScrapeJobData;
          jobId: string;
          priority: number;
          listenable?: boolean;
        }[]
      >();

      const jobsWithoutCrawlID: {
        data: ScrapeJobData;
        jobId: string;
        priority: number;
        listenable?: boolean;
      }[] = [];
      const crawlConcurrencyLimits: {
        crawlId: string;
        maxCrawlConcurrency: number;
        currentCrawlConcurrency: number;
        jobsCount: number;
      }[] = [];

      for (const job of teamJobs) {
        if (job.data.crawl_id) {
          if (!jobsByCrawlID.has(job.data.crawl_id)) {
            jobsByCrawlID.set(job.data.crawl_id, []);
          }
          jobsByCrawlID.get(job.data.crawl_id)!.push(job);
        } else {
          jobsWithoutCrawlID.push(job);
        }
      }

      // == Select jobs by crawl ID ==
      for (const [crawlID, crawlJobs] of jobsByCrawlID) {
        const crawl = await getCrawl(crawlID);
        const concurrencyLimit = !crawl
          ? null
          : crawl.crawlerOptions?.delay === undefined &&
              crawl.maxConcurrency === undefined
            ? null
            : (crawl.maxConcurrency ?? 1);

        if (concurrencyLimit === null) {
          // All jobs may be in the CQ depending on the global team concurrency limit
          jobsPotentiallyInCQ.push(...crawlJobs);
        } else {
          const currentCrawlConcurrency = (
            await getCrawlConcurrencyLimitActiveJobs(crawlID)
          ).length;
          const freeSlots = Math.max(
            concurrencyLimit - currentCrawlConcurrency,
            0,
          );
          const crawlLimitedJobs = crawlJobs.slice(freeSlots);

          // The first n jobs may be in the CQ depending on the global team concurrency limit
          jobsPotentiallyInCQ.push(...crawlJobs.slice(0, freeSlots));

          // Every job after that must be in the CQ, as the crawl concurrency limit has been reached
          jobsForcedToCQ.push(...crawlLimitedJobs);

          if (crawlLimitedJobs.length > 0) {
            crawlConcurrencyLimits.push({
              crawlId: crawlID,
              maxCrawlConcurrency: concurrencyLimit,
              currentCrawlConcurrency,
              jobsCount: crawlLimitedJobs.length,
            });
          }
        }
      }

      // All jobs without a crawl ID may be in the CQ depending on the global team concurrency limit
      jobsPotentiallyInCQ.push(...jobsWithoutCrawlID);

      // Bypass concurrency limits for self-hosted deployments
      let addToBull: typeof jobsPotentiallyInCQ;
      let addToCQ: typeof jobsPotentiallyInCQ;
      let maxConcurrency = 0;
      let currentActiveConcurrency: number | null = null;
      let countCanBeDirectlyAdded = 0;

      if (isSelfHosted()) {
        // For self-hosted, add all jobs directly to BullMQ
        addToBull = jobsPotentiallyInCQ;
        addToCQ = jobsForcedToCQ;
      } else {
        const now = Date.now();
        maxConcurrency =
          (await getACUCTeam(teamId, false, true, RateLimiterMode.Scrape))
            ?.concurrency ?? 2;
        await cleanOldConcurrencyLimitEntries(teamId, now);

        currentActiveConcurrency = await getCombinedTeamActiveCount(teamId);

        countCanBeDirectlyAdded = Math.max(
          maxConcurrency - currentActiveConcurrency,
          0,
        );

        addToBull = jobsPotentiallyInCQ.slice(0, countCanBeDirectlyAdded);
        addToCQ = jobsPotentiallyInCQ
          .slice(countCanBeDirectlyAdded)
          .concat(jobsForcedToCQ);

        if (addToCQ.length > 0) {
          const currentQueueSize = await getCombinedTeamPendingCount(teamId);
          const queueLimit = getTeamQueueLimit(maxConcurrency);
          if (currentQueueSize + addToCQ.length > queueLimit) {
            throw new QueueFullError(currentQueueSize, queueLimit);
          }
        }
      }

      if (addToCQ.length > 0) {
        const crawlConcurrencyLimitedJobs = crawlConcurrencyLimits.reduce(
          (sum, x) => sum + x.jobsCount,
          0,
        );
        const teamConcurrencyLimitedJobs = Math.max(
          addToCQ.length - crawlConcurrencyLimitedJobs,
          0,
        );

        if (currentActiveConcurrency === null) {
          const now = Date.now();
          await cleanOldConcurrencyLimitEntries(teamId, now);
          currentActiveConcurrency = await getCombinedTeamActiveCount(teamId);
        }

        _logger.info("Adding scrape jobs to concurrency queue", {
          teamId,
          concurrencyLimitReason:
            teamConcurrencyLimitedJobs > 0 && crawlConcurrencyLimitedJobs > 0
              ? "team-and-crawl"
              : crawlConcurrencyLimitedJobs > 0
                ? "crawl"
                : "team",
          maxConcurrency,
          currentConcurrency: currentActiveConcurrency,
          jobsCount: addToCQ.length,
          teamConcurrencyLimitedJobs,
          crawlConcurrencyLimitedJobs,
          crawlConcurrencyLimits,
        });
      }

      // equals 2x the max concurrency (only check for non-self-hosted)
      if (
        !isSelfHosted() &&
        jobsPotentiallyInCQ.length - countCanBeDirectlyAdded > maxConcurrency
      ) {
        // logger.info(`Concurrency limited 2x (multiple) - Concurrency queue jobs: ${addToCQ.length} Max concurrency: ${maxConcurrency} Team ID: ${jobs[0].data.team_id}`);
        // Only send notification if it's not a crawl or batch scrape
        if (!isCrawlOrBatchScrape(jobs[0].data)) {
          const shouldSendNotification =
            await shouldSendConcurrencyLimitNotification(jobs[0].data.team_id);
          if (shouldSendNotification) {
            sendNotificationWithCustomDays(
              jobs[0].data.team_id,
              NotificationType.CONCURRENCY_LIMIT_REACHED,
              15,
              false,
              true,
            ).catch(error => {
              _logger.error(
                "Error sending notification (concurrency limit reached)",
                { error },
              );
            });
          }
        }
      }

      await _addScrapeJobsToConcurrencyQueue(
        addToCQ.map(job => ({
          jobId: job.jobId,
          data: { ...job.data, traceContext },
          priority: job.priority,
          listenable: job.listenable,
        })),
      );

      const activeCandidates = addToBull.map(job => ({
        jobId: job.jobId,
        data: { ...job.data, traceContext },
        priority: job.priority,
        listenable: job.listenable,
      }));
      try {
        await _addScrapeJobsToBullMQ(
          activeCandidates,
          isSelfHosted() ? null : maxConcurrency,
        );
      } catch (error) {
        if (!(error instanceof PgCapacityReservationDeniedError)) throw error;
        const pending = await getCombinedTeamPendingCount(teamId);
        const queueLimit = getTeamQueueLimit(maxConcurrency);
        if (pending + activeCandidates.length > queueLimit) {
          throw new QueueFullError(pending, queueLimit);
        }
        await _addScrapeJobsToConcurrencyQueue(activeCandidates);
      }
    });
  }
}

export async function waitForJob(
  job: NuQJob<ScrapeJobData> | string,
  timeout: number | null,
  zeroDataRetention: boolean,
  logger: Logger = _logger,
): Promise<Document> {
  const jobId = typeof job == "string" ? job : job.id;
  const backend =
    typeof job === "string"
      ? undefined
      : ((job as NuQJob<ScrapeJobData> & { backend?: QueueBackend }).backend ??
        undefined);
  const isConcurrencyLimited = !!(typeof job === "string");

  let timeoutHandle: NodeJS.Timeout | null = null;
  let doc: Document | null = null;
  try {
    doc = await Promise.race(
      [
        routedScrapeQueue.waitForJob<Document>(
          jobId,
          timeout !== null ? timeout + 100 : null,
          logger,
          backend,
        ),
        timeout !== null
          ? new Promise<Document>((_resolve, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(
                  new ScrapeJobTimeoutError(
                    "Scrape timed out" +
                      (isConcurrencyLimited
                        ? " after waiting in the concurrency limit queue"
                        : ""),
                  ),
                );
              }, timeout);
            })
          : null,
      ].filter(x => x !== null),
    );
  } catch (e) {
    if (e instanceof TransportableError) {
      throw e;
    } else if (e instanceof Error) {
      const x = deserializeTransportableError(e.message);
      if (x) {
        throw x;
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  logger.debug("Got job");

  if (!doc) {
    const docs = await getJobFromGCS(jobId);
    logger.debug("Got job from GCS");
    if (!docs || docs.length === 0) {
      throw new Error("Job not found in GCS");
    }
    doc = docs[0]!;

    if (zeroDataRetention) {
      await removeJobFromGCS(jobId);
    }
  }

  return doc;
}
