import { Response } from "express";
import {
  CrawlStatusParams,
  CrawlStatusResponse,
  RequestWithAuth,
  Document,
} from "./types";
import {
  getCrawl,
  getCrawlExpiry,
  getCrawlQualifiedJobCount,
  getDoneJobsOrderedLength,
  getDoneJobsOrderedUntil,
  isCrawlKickoffFinished,
} from "../../lib/crawl-redis";
import {
  supabaseGetJobById,
  supabaseGetJobsById,
} from "../../lib/supabase-jobs";
import { configDotenv } from "dotenv";
import { logger } from "../../lib/logger";
import { supabase_rr_service, supabase_service } from "../../services/supabase";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  scrapeQueue,
  NuQJob,
  NuQJobStatus,
  crawlGroup,
} from "../../services/worker/nuq";
import { ScrapeJobSingleUrls } from "../../types";
import { redisEvictConnection } from "../../../src/services/redis";
import { isBaseDomain, extractBaseDomain } from "../../lib/url-utils";
configDotenv();

export type PseudoJob<T> = {
  id: string;
  status: NuQJobStatus;
  returnvalue: T | null;
  timestamp: number;
  data: {
    scrapeOptions: any;
    teamId?: string;
  };
  failedReason?: string;
};

export type DBJob = {
  docs: any;
  success: boolean;
  page_options: any;
  date_added: any;
  message: string | null;
  team_id: string;
};

export async function getJob(
  id: string,
  _logger = logger,
): Promise<PseudoJob<any> | null> {
  const [nuqJob, dbJob, gcsJob] = await Promise.all([
    scrapeQueue.getJob(
      id,
      _logger,
    ) as Promise<NuQJob<ScrapeJobSingleUrls> | null>,
    (process.env.USE_DB_AUTHENTICATION === "true"
      ? supabaseGetJobById(id)
      : null) as Promise<DBJob | null>,
    (process.env.GCS_BUCKET_NAME ? getJobFromGCS(id) : null) as Promise<
      any | null
    >,
  ]);

  if (!nuqJob && !dbJob) return null;

  if (nuqJob && nuqJob.data.mode !== "single_urls") {
    return null;
  }

  const data = gcsJob ?? dbJob?.docs ?? nuqJob?.returnvalue;
  if (gcsJob === null && data) {
    _logger.warn("GCS Job not found", {
      jobId: id,
    });
  }

  const job: PseudoJob<any> = {
    id,
    status: dbJob ? (dbJob.success ? "completed" : "failed") : nuqJob!.status,
    returnvalue: Array.isArray(data) ? data[0] : data,
    data: {
      scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbJob!.page_options,
    },
    timestamp: nuqJob
      ? nuqJob.createdAt.valueOf()
      : new Date(dbJob!.date_added).valueOf(),
    failedReason: (nuqJob ? nuqJob.failedReason : dbJob!.message) || undefined,
  };

  return job;
}

export async function getJobs(
  ids: string[],
  _logger = logger,
): Promise<PseudoJob<any>[]> {
  const [nuqJobs, dbJobs, gcsJobs] = await Promise.all([
    scrapeQueue.getJobs(ids, _logger) as Promise<NuQJob<ScrapeJobSingleUrls>[]>,
    process.env.USE_DB_AUTHENTICATION === "true"
      ? supabaseGetJobsById(ids)
      : [],
    process.env.GCS_BUCKET_NAME
      ? (Promise.all(
          ids.map(async x => ({ id: x, job: await getJobFromGCS(x) })),
        ).then(x => x.filter(x => x.job)) as Promise<
          { id: string; job: any | null }[]
        >)
      : [],
  ]);

  const nuqJobMap = new Map<string, NuQJob<any, any>>();
  const dbJobMap = new Map<string, DBJob>();
  const gcsJobMap = new Map<string, any>();

  for (const job of nuqJobs) {
    nuqJobMap.set(job.id, job);
  }

  for (const job of dbJobs) {
    dbJobMap.set(job.job_id, job);
  }

  for (const job of gcsJobs) {
    gcsJobMap.set(job.id, job.job);
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const nuqJob = nuqJobMap.get(id);
    const dbJob = dbJobMap.get(id);
    const gcsJob = gcsJobMap.get(id);

    if (!nuqJob && !dbJob) continue;

    const data = gcsJob ?? dbJob?.docs ?? nuqJob?.returnvalue;
    if (gcsJob === null && data) {
      logger.warn("GCS Job not found", {
        jobId: id,
      });
    }

    const job: PseudoJob<any> = {
      id,
      status: dbJob ? (dbJob.success ? "completed" : "failed") : nuqJob!.status,
      returnvalue: Array.isArray(data) ? data[0] : data,
      data: {
        scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbJob!.page_options,
      },
      timestamp: nuqJob
        ? nuqJob.createdAt.valueOf()
        : new Date(dbJob!.date_added).valueOf(),
      failedReason:
        (nuqJob ? nuqJob.failedReason : dbJob!.message) || undefined,
    };

    jobs.push(job);
  }

  return jobs;
}

export async function crawlStatusController(
  req: RequestWithAuth<CrawlStatusParams, undefined, CrawlStatusResponse>,
  res: Response<CrawlStatusResponse>,
  isBatch = false,
) {
  const uuidReg =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!req.params.jobId || !uuidReg.test(req.params.jobId)) {
    return res.status(400).json({
      success: false,
      error: "Invalid job ID",
    });
  }

  const start =
    typeof req.query.skip === "string" ? parseInt(req.query.skip, 10) : 0;
  const end =
    typeof req.query.limit === "string"
      ? start + parseInt(req.query.limit, 10) - 1
      : undefined;

  const group = await crawlGroup.getGroup(req.params.jobId);
  const groupAnyJob = await scrapeQueue.getGroupAnyJob(
    req.params.jobId,
    req.auth.team_id,
  );
  const sc = await getCrawl(req.params.jobId);

  if (!group || (!groupAnyJob && (!sc || sc.team_id !== req.auth.team_id))) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  const zeroDataRetention = !!(
    groupAnyJob?.data?.zeroDataRetention ?? sc?.zeroDataRetention
  );

  const numericStats = await scrapeQueue.getGroupNumericStats(
    req.params.jobId,
    logger.child({ zeroDataRetention }),
  );

  const creditsRpc =
    process.env.USE_DB_AUTHENTICATION === "true"
      ? await supabase_service.rpc(
          "credits_billed_by_crawl_id_1",
          {
            i_crawl_id: req.params.jobId,
          },
          { get: true },
        )
      : null;

  let outputBulkA: {
    status?: "completed" | "scraping" | "cancelled";
    completed?: number;
    total?: number;
    creditsUsed?: number;
  } = {
    status: group.status === "active" ? "scraping" : group.status,
    completed: numericStats.completed ?? 0,
    total:
      (numericStats.completed ?? 0) +
      (numericStats.active ?? 0) +
      (numericStats.queued ?? 0) +
      (numericStats.backlog ?? 0),
    creditsUsed: creditsRpc?.data?.[0]?.credits_billed ?? -1,
  };

  let outputBulkB: {
    data: Document[];
    next: string | undefined;
  };

  const doneJobs = await scrapeQueue.getCrawlJobsForListing(
    req.params.jobId,
    end !== undefined ? end - start : 100,
    start,
    logger.child({ zeroDataRetention }),
  );

  let scrapes: Document[] = [];
  let iteratedOver = 0;
  let bytes = 0;
  const bytesLimit = 10485760; // 10 MiB in bytes

  const scrapeBlobs = await Promise.all(
    doneJobs.map(
      async x =>
        [x.id, x.returnvalue ?? (await getJobFromGCS(x.id))?.[0]] as const,
    ),
  );

  for (const [id, scrape] of scrapeBlobs) {
    if (scrape) {
      scrapes.push(scrape);
      bytes += JSON.stringify(scrape).length;
    } else {
      logger.warn("Job was considered done, but returnvalue is undefined!", {
        jobId: id,
        returnvalue: scrape,
        zeroDataRetention,
      });
    }

    iteratedOver++;

    if (bytes > bytesLimit) {
      break;
    }
  }

  if (bytes > bytesLimit && scrapes.length !== 1) {
    scrapes.splice(scrapes.length - 1, 1);
    iteratedOver--;
  }

  outputBulkB = {
    data: scrapes,
    next:
      (outputBulkA.total ?? 0) > start + iteratedOver ||
      outputBulkA.status !== "completed"
        ? `${req.protocol}://${req.get("host")}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
        : undefined,
  };

  // Check for robots.txt blocked URLs and add warning if found
  let warning: string | undefined;
  try {
    const robotsBlocked = await redisEvictConnection.smembers(
      "crawl:" + req.params.jobId + ":robots_blocked",
    );
    const rbCount = robotsBlocked?.length ?? 0;
    // Emit as separate simple logs so no meta is lost in sinks
    const statusNow = outputBulkA.status ?? "scraping";
    if (rbCount > 0 && statusNow !== "scraping") {
      warning =
        "One or more pages were unable to be crawled because the robots.txt file prevented this. Please use the /scrape endpoint instead.";
    }
  } catch (error) {
    // If we can't check robots blocked URLs, continue without warning
    logger.debug("Failed to check robots blocked URLs", {
      error,
      zeroDataRetention,
    });
  }

  // Check if we should warn about base domain for crawl results
  const resultCount =
    outputBulkA.completed ?? outputBulkA.total ?? outputBulkB.data.length;
  const currentStatus = outputBulkA.status ?? "scraping";
  if (!warning && currentStatus !== "scraping" && resultCount <= 1) {
    // Get the original crawl URL and options from stored crawl data
    const crawl = await getCrawl(req.params.jobId);
    if (crawl && crawl.originUrl && !isBaseDomain(crawl.originUrl)) {
      // Don't show warning if user is already using crawlEntireDomain
      const isUsingCrawlEntireDomain =
        crawl.crawlerOptions?.crawlEntireDomain === true;
      if (!isUsingCrawlEntireDomain) {
        const baseDomain = extractBaseDomain(crawl.originUrl);
        if (baseDomain) {
          warning = `Only ${resultCount} result(s) found. For broader coverage, try crawling with crawlEntireDomain=true or start from a higher-level path like ${baseDomain}`;
        }
      }
    }
  }

  return res.status(200).json({
    success: true,
    status: outputBulkA.status ?? "scraping",
    completed: outputBulkA.completed ?? 0,
    total: outputBulkA.total ?? 0,
    creditsUsed: outputBulkA.creditsUsed ?? 0,
    expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
    next: outputBulkB.next,
    data: outputBulkB.data,
    ...(warning && { warning }),
  });
}
