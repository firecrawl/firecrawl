import { v7 as uuidv7 } from "uuid";
import { NotificationType, RateLimiterMode, ScrapeJobData } from "../types";
import {
  cleanOldConcurrencyLimitEntries,
  getConcurrencyLimitActiveJobs,
  getConcurrencyQueueJobsCount,
  getCrawlConcurrencyLimitActiveJobs,
  pushConcurrencyLimitActiveJob,
  pushConcurrencyLimitedJob,
  pushCrawlConcurrencyLimitActiveJob,
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
import { NuQJob, scrapeQueue } from "./worker/nuq";
import { serializeTraceContext } from "../lib/otel-tracer";
import { isSelfHosted } from "../lib/deployment";

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
      backloggedTimesOutAt: webScraperOptions.crawl_id
        ? undefined
        : new Date(
            Date.now() +
              (webScraperOptions.scrapeOptions?.timeout ?? 60 * 1000),
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
    webScraperOptions.crawl_id
      ? Infinity
      : (webScraperOptions.scrapeOptions?.timeout ?? 60 * 1000),
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
        backloggedTimesOutAt: job.data.crawl_id
          ? undefined
          : new Date(
              Date.now() + (job.data.scrapeOptions?.timeout ?? 60 * 1000),
            ),
      },
    })),
  );

  for (const job of jobs) {
    await pushConcurrencyLimitedJob(
      job.data.team_id,
      {
        id: job.jobId,
        data: job.data,
        priority: job.priority,
        listenable: job.listenable ?? false,
      },
      job.data.crawl_id
        ? Infinity
        : (job.data.scrapeOptions?.timeout ?? 60 * 1000),
    );
  }
}

export async function _addScrapeJobToBullMQ(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData>> {
  if (webScraperOptions.mode === "single_urls") {
    abTestJob(webScraperOptions);
  }

  if (webScraperOptions && webScraperOptions.team_id) {
    await pushConcurrencyLimitActiveJob(
      webScraperOptions.team_id,
      jobId,
      60 * 1000,
    ); // 60s default timeout

    if (webScraperOptions.crawl_id) {
      const sc = await getCrawl(webScraperOptions.crawl_id);
      if (sc?.crawlerOptions?.delay || sc?.maxConcurrency) {
        await pushCrawlConcurrencyLimitActiveJob(
          webScraperOptions.crawl_id,
          jobId,
          60 * 1000,
        );
      }
    }
  }

  return await scrapeQueue.addJob(jobId, webScraperOptions, {
    priority,
    listenable,
    ownerId: webScraperOptions.team_id ?? undefined,
    groupId: webScraperOptions.crawl_id ?? undefined,
  });
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
    if (job.data.mode === "single_urls") {
      abTestJob(job.data);
    }

    if (job.data && job.data.team_id) {
      await pushConcurrencyLimitActiveJob(
        job.data.team_id,
        job.jobId,
        60 * 1000,
      ); // 60s default timeout

      if (job.data.crawl_id) {
        const sc = await getCrawl(job.data.crawl_id);
        if (sc?.crawlerOptions?.delay || sc?.maxConcurrency) {
          await pushCrawlConcurrencyLimitActiveJob(
            job.data.crawl_id,
            job.jobId,
            60 * 1000,
          );
        }
      }
    }
  }

  return await scrapeQueue.addJobs(
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
}

async function addScrapeJobRaw(
  webScraperOptions: ScrapeJobData,
  jobId: string,
  priority: number = 0,
  directToBullMQ: boolean = false,
  listenable: boolean = false,
): Promise<NuQJob<ScrapeJobData> | null> {
  let concurrencyLimited: "yes" | "yes-crawl" | "no" | null = null;
  let currentActiveConcurrency = 0;
  let maxConcurrency = 0;

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
        const crawlConcurrency = (
          await getCrawlConcurrencyLimitActiveJobs(webScraperOptions.crawl_id)
        ).length;
        const freeSlots = Math.max(concurrencyLimit - crawlConcurrency, 0);
        if (freeSlots === 0) {
          concurrencyLimited = "yes-crawl";
        }
      }
    }

    if (concurrencyLimited === null) {
      const now = Date.now();
      const maxConcurrency =
        (
          await getACUCTeam(
            webScraperOptions.team_id,
            false,
            true,
            webScraperOptions.mode === "single_urls" &&
              webScraperOptions.from_extract
              ? RateLimiterMode.Extract
              : RateLimiterMode.Crawl,
          )
        )?.concurrency ?? 2;
      await cleanOldConcurrencyLimitEntries(webScraperOptions.team_id, now);
      const currentActiveConcurrency = (
        await getConcurrencyLimitActiveJobs(webScraperOptions.team_id, now)
      ).length;
      concurrencyLimited =
        currentActiveConcurrency >= maxConcurrency ? "yes" : "no";
    }
  }

  if (concurrencyLimited === "yes" || concurrencyLimited === "yes-crawl") {
    if (concurrencyLimited === "yes") {
      // Detect if they hit their concurrent limit
      // If above by 2x, send them an email
      // No need to 2x as if there are more than the max concurrency in the concurrency queue, it is already 2x
      const concurrencyQueueJobs = await getConcurrencyQueueJobsCount(
        webScraperOptions.team_id,
      );
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
    return await _addScrapeJobToBullMQ(
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

  for (const [teamId, teamJobs] of jobsByTeam) {
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
        const crawlConcurrency = (
          await getCrawlConcurrencyLimitActiveJobs(crawlID)
        ).length;
        const freeSlots = Math.max(concurrencyLimit - crawlConcurrency, 0);

        // The first n jobs may be in the CQ depending on the global team concurrency limit
        jobsPotentiallyInCQ.push(...crawlJobs.slice(0, freeSlots));

        // Every job after that must be in the CQ, as the crawl concurrency limit has been reached
        jobsForcedToCQ.push(...crawlJobs.slice(freeSlots));
      }
    }

    // All jobs without a crawl ID may be in the CQ depending on the global team concurrency limit
    jobsPotentiallyInCQ.push(...jobsWithoutCrawlID);

    // Bypass concurrency limits for self-hosted deployments
    let addToBull: typeof jobsPotentiallyInCQ;
    let addToCQ: typeof jobsPotentiallyInCQ;
    let maxConcurrency = 0;
    let countCanBeDirectlyAdded = 0;

    if (isSelfHosted()) {
      // For self-hosted, add all jobs directly to BullMQ
      addToBull = jobsPotentiallyInCQ;
      addToCQ = jobsForcedToCQ;
    } else {
      const now = Date.now();
      maxConcurrency =
        (
          await getACUCTeam(
            teamId,
            false,
            true,
            jobs[0].data.mode === "single_urls" && jobs[0].data.from_extract
              ? RateLimiterMode.Extract
              : RateLimiterMode.Crawl,
          )
        )?.concurrency ?? 2;
      await cleanOldConcurrencyLimitEntries(teamId, now);

      const currentActiveConcurrency = (
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
        scrapeQueue.waitForJob(
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
