import { v7 as uuidv7 } from "uuid";
import { ScrapeJobData } from "../types";
import {
  cleanOldConcurrencyLimitEntries,
  getConcurrencyLimitActiveJobs,
  getConcurrencyQueueJobsCount,
  getCrawlConcurrencyLimitActiveJobs,
  getTeamQueueLimit,
  MAX_BACKLOG_TIMEOUT_MS,
  observeJobEnqueued,
  pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob,
  pushConcurrencyLimitedJobs,
  pushCrawlConcurrencyLimitActiveJob,
  QueueFullError,
} from "../lib/concurrency-limit";
import { logger as _logger } from "../lib/logger";
import { Document } from "../controllers/v2/types";
import { service } from "../service";
import { getCrawl } from "../lib/crawl-redis";
import { recordCrawlStateMissing } from "../lib/crawl-state-metrics";
import { currentLimits } from "../lib/limits";
import { jobContext } from "../lib/request-context";
import { Logger } from "winston";
import { isTransportableError, ScrapeJobTimeoutError } from "../lib/error";
import { deserializeTransportableError } from "../lib/error-serde";
import { NuQJob, scrapeQueue } from "./worker/nuq";
import {
  fdbEnqueueScrapeJobs,
  resolveJobBackend,
  scrapeQueue as routedScrapeQueue,
} from "./worker/nuq-router";
import {
  nuqFdbHealthCheck,
  scrapeQueueFdb,
  withFdbTimeout,
} from "./worker/nuq-fdb";
import { serializeTraceContext } from "../lib/otel-tracer";
import { installedService } from "../service/service";

// Queue-wait deadline for a backlogged job (how long its owner still cares about the result)
function backlogTimeoutMs(data: ScrapeJobData): number {
  if (typeof data.backlogTimeoutMs === "number") return data.backlogTimeoutMs;
  if (data.crawl_id) return MAX_BACKLOG_TIMEOUT_MS;
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

function observeConcurrencyLimited(
  data: ScrapeJobData,
  limit: number,
  extra?: { exceededBacklog?: boolean },
): void {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("concurrency.limited")) return;
  hooks.observe("concurrency.limited", {
    ctx: jobContext(data),
    limit,
    isCrawlOrBatch: isCrawlOrBatchScrape(data),
    ...(extra?.exceededBacklog !== undefined
      ? { exceededBacklog: extra.exceededBacklog }
      : {}),
  });
}

async function _addScrapeJobToConcurrencyQueue(
  webScraperOptions: any,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
) {
  await scrapeQueue.addJob(
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

  await pushConcurrencyLimitedJob(
    webScraperOptions.team_id,
    {
      id: jobId,
      data: webScraperOptions,
      priority,
      listenable,
    },
    backlogTimeoutMs(webScraperOptions),
  );
}

async function _addScrapeJobsToConcurrencyQueue(
  jobs: {
    data: any;
    jobId: string;
    priority: number;
    listenable?: boolean;
  }[],
) {
  await scrapeQueue.addJobs(
    jobs.map(job => ({
      id: job.jobId,
      data: job.data,
      options: {
        priority: job.priority,
        listenable: job.listenable ?? false,
        ownerId: job.data.team_id ?? undefined,
        groupId: job.data.crawl_id ?? undefined,
        backlogged: true,
        backloggedTimesOutAt: new Date(Date.now() + backlogTimeoutMs(job.data)),
      },
    })),
  );

  const jobsByTeam = new Map<
    string,
    {
      job: { id: string; data: any; priority: number; listenable: boolean };
      timeout: number;
    }[]
  >();

  for (const job of jobs) {
    const teamId = job.data.team_id as string;
    if (!jobsByTeam.has(teamId)) {
      jobsByTeam.set(teamId, []);
    }
    jobsByTeam.get(teamId)!.push({
      job: {
        id: job.jobId,
        data: job.data,
        priority: job.priority,
        listenable: job.listenable ?? false,
      },
      timeout: backlogTimeoutMs(job.data),
    });
  }

  for (const [teamId, teamJobs] of jobsByTeam) {
    await pushConcurrencyLimitedJobs(teamId, teamJobs);
  }
}

export async function _addScrapeJobToBullMQ(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData>> {
  // direct adds bypass the gates; on the FDB backend that's a slotless enqueue
  if ((await resolveJobBackend(webScraperOptions)) === "fdb") {
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
    observeJobEnqueued(jobId, webScraperOptions);
    return jobs[0];
  }

  return _addScrapeJobToBullMQPg(
    webScraperOptions,
    jobId,
    priority,
    listenable,
  );
}

async function _addScrapeJobToBullMQPg(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData>> {
  if (webScraperOptions && webScraperOptions.team_id) {
    await pushConcurrencyLimitActiveJob(
      webScraperOptions.team_id,
      jobId,
      60 * 1000,
    ); // 60s default timeout

    if (webScraperOptions.crawl_id) {
      const sc = await getCrawl(webScraperOptions.crawl_id);
      if (!sc || sc.crawlerOptions?.delay || sc.maxConcurrency) {
        await pushCrawlConcurrencyLimitActiveJob(
          webScraperOptions.crawl_id,
          jobId,
          60 * 1000,
        );
      }
    }
  }

  const added = await scrapeQueue.addJob(jobId, webScraperOptions, {
    priority,
    listenable,
    ownerId: webScraperOptions.team_id ?? undefined,
    groupId: webScraperOptions.crawl_id ?? undefined,
  });
  observeJobEnqueued(jobId, webScraperOptions);
  return added;
}

async function _addScrapeJobsToBullMQ(
  jobs: {
    data: any;
    jobId: string;
    priority: number;
    listenable?: boolean;
  }[],
): Promise<NuQJob<ScrapeJobData>[]> {
  for (const job of jobs) {
    if (job.data && job.data.team_id) {
      await pushConcurrencyLimitActiveJob(
        job.data.team_id,
        job.jobId,
        60 * 1000,
      ); // 60s default timeout

      if (job.data.crawl_id) {
        const sc = await getCrawl(job.data.crawl_id);
        if (!sc || sc.crawlerOptions?.delay || sc.maxConcurrency) {
          await pushCrawlConcurrencyLimitActiveJob(
            job.data.crawl_id,
            job.jobId,
            60 * 1000,
          );
        }
      }
    }
  }

  const added = await scrapeQueue.addJobs(
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
  for (const job of jobs) {
    observeJobEnqueued(job.jobId, job.data);
  }
  return added;
}

async function addScrapeJobFdb(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number,
  directToBullMQ: boolean,
  listenable: boolean,
): Promise<NuQJob<ScrapeJobData> | null> {
  const { jobs, backloggedCount, teamLimit, backlogLimit } =
    await fdbEnqueueScrapeJobs(
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

  // FDB promotes backlogged jobs inside a transaction without loading job payloads,
  // so enqueue time is the only point where RequestContext and kind are available.
  observeJobEnqueued(jobId, webScraperOptions);

  if (backloggedCount > 0) {
    const limitedBy = backlogLimit ?? teamLimit;
    if (limitedBy !== null) {
      const exceededBacklog = await checkFdbBacklogExceeded(
        webScraperOptions.team_id,
        teamLimit,
        isCrawlOrBatchScrape(webScraperOptions),
      );
      observeConcurrencyLimited(webScraperOptions, limitedBy, {
        exceededBacklog,
      });
    }
    // matches the PG contract: null = job waiting in the concurrency queue
    return null;
  }
  return jobs[0];
}

const FDB_OPTIONAL_COUNT_TIMEOUT_MS = 500;

async function checkFdbBacklogExceeded(
  teamId: string,
  teamLimit: number | null,
  crawlOrBatch: boolean,
): Promise<boolean> {
  if (teamLimit === null || crawlOrBatch) return false;
  try {
    if (!(await nuqFdbHealthCheck(FDB_OPTIONAL_COUNT_TIMEOUT_MS))) return false;
    const pending = await withFdbTimeout(
      scrapeQueueFdb.getTeamPendingCount(teamId),
      FDB_OPTIONAL_COUNT_TIMEOUT_MS,
    );
    return pending > teamLimit;
  } catch (error) {
    _logger.warn("Failed to check FDB concurrency backlog", { error });
    return false;
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
  let maxConcurrency: number | null = null;
  let currentCrawlConcurrency: number | null = null;
  let maxCrawlConcurrency: number | null = null;

  if (directToBullMQ) {
    concurrencyLimited = "no";
  } else {
    if (webScraperOptions.crawl_id) {
      const crawl = await getCrawl(webScraperOptions.crawl_id);
      if (!crawl) {
        recordCrawlStateMissing("gate", webScraperOptions.crawl_id, _logger, {
          teamId: webScraperOptions.team_id,
          jobId,
        });
      }
      const concurrencyLimit = !crawl
        ? 1
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

    const ctx = jobContext(webScraperOptions);
    maxConcurrency = await currentLimits().concurrency(
      ctx.concurrencyLimit !== undefined
        ? { ...ctx, concurrencyLimit: undefined }
        : ctx,
    );

    if (concurrencyLimited === null) {
      if (maxConcurrency === null) {
        concurrencyLimited = "no";
      } else {
        const now = Date.now();
        await cleanOldConcurrencyLimitEntries(webScraperOptions.team_id, now);
        currentActiveConcurrency = (
          await getConcurrencyLimitActiveJobs(webScraperOptions.team_id, now)
        ).length;
        concurrencyLimited =
          currentActiveConcurrency >= maxConcurrency ? "yes" : "no";
      }
    }
  }

  if (concurrencyLimited === "yes" || concurrencyLimited === "yes-crawl") {
    const concurrencyQueueJobs = await getConcurrencyQueueJobsCount(
      webScraperOptions.team_id,
    );

    if (maxConcurrency !== null) {
      const queueLimit = getTeamQueueLimit(maxConcurrency);
      if (concurrencyQueueJobs >= queueLimit) {
        throw new QueueFullError(concurrencyQueueJobs, queueLimit);
      }
    }

    if (currentActiveConcurrency === null) {
      const now = Date.now();
      await cleanOldConcurrencyLimitEntries(webScraperOptions.team_id, now);
      currentActiveConcurrency = (
        await getConcurrencyLimitActiveJobs(webScraperOptions.team_id, now)
      ).length;
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

    webScraperOptions.concurrencyLimited = true;

    await _addScrapeJobToConcurrencyQueue(
      webScraperOptions,
      jobId,
      priority,
      listenable,
    );
    if (concurrencyLimited === "yes" && maxConcurrency !== null) {
      observeConcurrencyLimited(webScraperOptions, maxConcurrency, {
        exceededBacklog: concurrencyQueueJobs > maxConcurrency,
      });
    } else if (
      concurrencyLimited === "yes-crawl" &&
      maxCrawlConcurrency !== null
    ) {
      observeConcurrencyLimited(webScraperOptions, maxCrawlConcurrency);
    }
    return null;
  } else {
    return await _addScrapeJobToBullMQPg(
      webScraperOptions,
      jobId,
      priority,
      listenable,
    );
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

  return await addScrapeJobRaw(
    optionsWithTrace,
    jobId,
    priority,
    directToBullMQ,
    listenable,
  );
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
    if (fdbJobs.length > 0) {
      const {
        jobs: enqueuedFdbJobs,
        backloggedCount,
        teamLimit,
        backlogLimit,
      } = await fdbEnqueueScrapeJobs(
        fdbJobs.map(job => ({
          jobId: job.jobId,
          data: { ...job.data, traceContext },
          priority: job.priority,
          listenable: job.listenable,
          backlogTimeoutMs: backlogTimeoutMs(job.data),
        })),
        teamId,
      );
      // FDB promotes backlogged jobs inside a transaction without loading job payloads,
      // so enqueue time is the only point where RequestContext and kind are available.
      for (const job of fdbJobs) {
        observeJobEnqueued(job.jobId, { ...job.data, traceContext });
      }
      if (backloggedCount > 0) {
        const limitedBy = backlogLimit ?? teamLimit;
        if (limitedBy !== null) {
          const backloggedIdx = enqueuedFdbJobs?.findIndex(
            j => j.status === "backlog",
          );
          const sample =
            backloggedIdx !== undefined && backloggedIdx >= 0
              ? fdbJobs[backloggedIdx]
              : fdbJobs[0];
          const exceededBacklog = await checkFdbBacklogExceeded(
            teamId,
            teamLimit,
            isCrawlOrBatchScrape(fdbJobs[0].data),
          );
          observeConcurrencyLimited(
            { ...sample.data, traceContext },
            limitedBy,
            { exceededBacklog },
          );
        }
      }
    }

    const teamJobs = allTeamJobs.filter(
      j => backendByJob.get(j.jobId) === "pg",
    );
    if (teamJobs.length === 0) continue;
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
      if (!crawl) {
        recordCrawlStateMissing("gate", crawlID, _logger, {
          teamId,
          jobCount: crawlJobs.length,
        });
      }
      const concurrencyLimit = !crawl
        ? 1
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

    const firstCtx = teamJobs.length > 0 ? jobContext(teamJobs[0].data) : null;
    const liveFirstCtx =
      firstCtx && firstCtx.concurrencyLimit !== undefined
        ? { ...firstCtx, concurrencyLimit: undefined }
        : firstCtx;
    const maxConcurrency =
      liveFirstCtx && liveFirstCtx.teamId === teamId
        ? await currentLimits().concurrency(liveFirstCtx)
        : await currentLimits().teamConcurrency(teamId);

    let addToBull: typeof jobsPotentiallyInCQ;
    let addToCQ: typeof jobsPotentiallyInCQ;
    let currentActiveConcurrency: number | null = null;
    let countCanBeDirectlyAdded = 0;

    if (maxConcurrency === null) {
      addToBull = jobsPotentiallyInCQ;
      addToCQ = jobsForcedToCQ;
    } else {
      const now = Date.now();
      await cleanOldConcurrencyLimitEntries(teamId, now);

      currentActiveConcurrency = (
        await getConcurrencyLimitActiveJobs(teamId, now)
      ).length;

      countCanBeDirectlyAdded = Math.max(
        maxConcurrency - currentActiveConcurrency,
        0,
      );

      addToBull = jobsPotentiallyInCQ.slice(0, countCanBeDirectlyAdded);
      addToCQ = jobsPotentiallyInCQ
        .slice(countCanBeDirectlyAdded)
        .concat(jobsForcedToCQ);

      if (addToCQ.length > 0) {
        const currentQueueSize = await getConcurrencyQueueJobsCount(teamId);
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
        currentActiveConcurrency = (
          await getConcurrencyLimitActiveJobs(teamId, now)
        ).length;
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

    await _addScrapeJobsToConcurrencyQueue(
      addToCQ.map(job => ({
        jobId: job.jobId,
        data: { ...job.data, traceContext },
        priority: job.priority,
        listenable: job.listenable,
      })),
    );
    if (
      maxConcurrency !== null &&
      jobsPotentiallyInCQ.length > countCanBeDirectlyAdded
    ) {
      observeConcurrencyLimited(
        { ...jobsPotentiallyInCQ[countCanBeDirectlyAdded].data, traceContext },
        maxConcurrency,
        {
          exceededBacklog:
            jobsPotentiallyInCQ.length - countCanBeDirectlyAdded >
            maxConcurrency,
        },
      );
    }
    for (const crawlLimit of crawlConcurrencyLimits) {
      const crawlSample = jobsForcedToCQ.find(
        job => job.data.crawl_id === crawlLimit.crawlId,
      );
      if (crawlSample) {
        observeConcurrencyLimited(
          { ...crawlSample.data, traceContext },
          crawlLimit.maxCrawlConcurrency,
        );
      }
    }

    await _addScrapeJobsToBullMQ(
      addToBull.map(job => ({
        jobId: job.jobId,
        data: { ...job.data, traceContext },
        priority: job.priority,
        listenable: job.listenable,
      })),
    );
  }
}

export async function waitForJob(
  job: NuQJob<ScrapeJobData> | string,
  timeout: number | null,
  zeroDataRetention: boolean,
  logger: Logger = _logger,
): Promise<Document> {
  const jobId = typeof job == "string" ? job : job.id;
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
    if (isTransportableError(e)) {
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
    const stored = await service.modules.jobStore.read(jobId, "scrape");
    logger.debug("Got job from job store");
    if (!stored?.document) {
      throw new Error("Job result not found in job store");
    }
    doc = stored.document;

    if (zeroDataRetention) {
      await service.modules.jobStore.remove(jobId, "scrape");
    }
  }

  return doc;
}
