import { Response } from "express";
import { config } from "../../config";
import {
  CrawlStatusParams,
  CrawlStatusResponse,
  Document,
  RequestWithAuth,
} from "./types";
import {
  getCrawl,
  getCrawlError,
  getCrawlExpiry,
  getDoneJobsOrderedLength,
  isCrawlKickoffFinished,
  getCrawlQualifiedJobCount,
  getDoneJobsOrderedUntil,
} from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  scrapeQueue,
  NuQJob,
  NuQJobStatus,
  crawlGroup,
} from "../../services/worker/nuq-router";
import { ScrapeJobSingleUrls } from "../../types";
import { readScrapeJobState } from "../../lib/job-state-store";
import { readRequestCredits } from "../../lib/request-credits-store";
import { readRequestCreditsFromAnalytics } from "../../lib/request-credits-analytics";
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

export async function getJob(id: string): Promise<PseudoJob<any> | null> {
  let stateReadError: unknown = null;
  const [nuqJob, scrapeState, gcsJob] = await Promise.all([
    scrapeQueue.getJob(id) as Promise<NuQJob<ScrapeJobSingleUrls> | null>,
    readScrapeJobState(id).catch(error => {
      logger.warn("Bigtable scrape state read failed", {
        error,
        scrapeId: id,
      });
      stateReadError = error;
      return null;
    }),
    (config.GCS_BUCKET_NAME ? getJobFromGCS(id) : null) as Promise<any | null>,
  ]);

  if (!nuqJob && !scrapeState) {
    // With no NuQ job, Bigtable is the only place a finished job's state
    // lives. A failed read is an outage, not a missing job: surface it rather
    // than answer 404 for a job that exists.
    if (stateReadError) throw stateReadError;
    return null;
  }

  if (nuqJob && nuqJob.data.mode !== "single_urls") {
    return null;
  }

  const data = gcsJob ?? nuqJob?.returnvalue;
  if (gcsJob === null && data) {
    logger.warn("GCS Job not found", {
      jobId: id,
    });
  }

  const job: PseudoJob<any> = {
    id,
    status: scrapeState?.status ?? nuqJob!.status,
    returnvalue: Array.isArray(data) ? data[0] : data,
    data: {
      scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : null,
    },
    timestamp: scrapeState?.completedAtMs ?? nuqJob!.createdAt.valueOf(),
    failedReason: (scrapeState?.error ?? nuqJob?.failedReason) || undefined,
  };

  return job;
}

export async function getJobs(ids: string[]): Promise<PseudoJob<any>[]> {
  const [nuqJobs, gcsJobs] = await Promise.all([
    scrapeQueue.getJobs(ids) as Promise<NuQJob<ScrapeJobSingleUrls>[]>,
    config.GCS_BUCKET_NAME
      ? (Promise.all(
          ids.map(async x => ({ id: x, job: await getJobFromGCS(x) })),
        ).then(x => x.filter(x => x.job)) as Promise<
          { id: string; job: any | null }[]
        >)
      : [],
  ]);

  const nuqJobMap = new Map<string, NuQJob<any, any>>();
  const gcsJobMap = new Map<string, any>();

  for (const job of nuqJobs) {
    nuqJobMap.set(job.id, job);
  }

  for (const job of gcsJobs) {
    gcsJobMap.set(job.id, job.job);
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const nuqJob = nuqJobMap.get(id);
    const gcsJob = gcsJobMap.get(id);

    if (!nuqJob) continue;

    const data = gcsJob ?? nuqJob.returnvalue;
    if (gcsJob === null && data) {
      logger.warn("GCS Job not found", {
        jobId: id,
      });
    }

    const job: PseudoJob<any> = {
      id,
      status: nuqJob.status,
      returnvalue: Array.isArray(data) ? data[0] : data,
      data: {
        scrapeOptions: nuqJob.data.scrapeOptions,
      },
      timestamp: nuqJob.createdAt.valueOf(),
      failedReason: nuqJob.failedReason || undefined,
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

  let creditsBilled = await readRequestCredits(req.params.jobId).catch(
    error => {
      logger.warn("Bigtable request credits read failed", { error });
      return null;
    },
  );
  if (creditsBilled === null) {
    // Requests from before the Bigtable credit rows existed: sum the scrape
    // job log instead.
    creditsBilled = await readRequestCreditsFromAnalytics(req.params.jobId, {
      emptyAsZero: true,
    }).catch(error => {
      logger.warn("Analytics request credits read failed", { error });
      return null;
    });
  }

  // check if the crawl failed during kickoff (e.g. queue full)
  const crawlError = await getCrawlError(req.params.jobId);

  let outputBulkA: {
    status?: "completed" | "scraping" | "cancelled" | "failed";
    completed?: number;
    total?: number;
    creditsUsed?: number;
  } = {
    status: sc?.cancelled
      ? "cancelled"
      : group.status === "active"
        ? "scraping"
        : group.status,
    completed: numericStats.completed ?? 0,
    total:
      (numericStats.completed ?? 0) +
      (numericStats.active ?? 0) +
      (numericStats.queued ?? 0) +
      (numericStats.backlog ?? 0),
    creditsUsed: creditsBilled ?? -1,
  };

  // if the crawl has a stored error and no jobs were ever created, mark as failed
  if (
    crawlError &&
    outputBulkA.total === 0 &&
    outputBulkA.status === "completed"
  ) {
    outputBulkA.status = "failed";
  }

  // if the crawl failed during kickoff, return immediately without fetching/processing jobs (there are none)
  if (outputBulkA.status === "failed" && crawlError) {
    return res.status(200).json({
      success: false,
      error: crawlError,
      status: "failed",
      completed: 0,
      total: 0,
      creditsUsed: outputBulkA.creditsUsed ?? 0,
      expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
      data: [],
    });
  }

  let outputBulkB: {
    data: Document[];
    next: string | undefined;
  };

  const doneJobs = await scrapeQueue.getGroupJobs(
    req.params.jobId,
    "completed",
    end !== undefined ? end - start + 1 : 100,
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
        ? `${req.protocol}://${req.host}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
        : undefined,
  };

  return res.status(200).json({
    success: true,
    status: outputBulkA.status ?? "scraping",
    completed: outputBulkA.completed ?? 0,
    total: outputBulkA.total ?? 0,
    creditsUsed: outputBulkA.creditsUsed ?? 0,
    expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
    next: outputBulkB.next,
    data: outputBulkB.data,
  });
}
