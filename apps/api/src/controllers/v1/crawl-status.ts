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
  getCrawlExpiry,
  getDoneJobsOrderedLength,
  isCrawlKickoffFinished,
  getCrawlQualifiedJobCount,
  getDoneJobsOrderedUntil,
} from "../../lib/crawl-redis";
import {
  supabaseGetScrapeById,
  supabaseGetScrapesById,
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

export type DBScrape = {
  id: string;
  success: boolean;
  options: any;
  created_at: any;
  error: string | null;
  team_id: string;
};

export async function getJob(id: string): Promise<PseudoJob<any> | null> {
  const [nuqJob, dbScrape, gcsJob] = await Promise.all([
    scrapeQueue.getJob(id) as Promise<NuQJob<ScrapeJobSingleUrls> | null>,
    (config.USE_DB_AUTHENTICATION
      ? supabaseGetScrapeById(id)
      : null) as Promise<DBScrape | null>,
    (config.GCS_BUCKET_NAME ? getJobFromGCS(id) : null) as Promise<any | null>,
  ]);

  if (!nuqJob && !dbScrape) return null;

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
    status: dbScrape
      ? dbScrape.success
        ? "completed"
        : "failed"
      : nuqJob!.status,
    returnvalue: Array.isArray(data) ? data[0] : data,
    data: {
      scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbScrape!.options,
    },
    timestamp: nuqJob
      ? nuqJob.createdAt.valueOf()
      : new Date(dbScrape!.created_at).valueOf(),
    failedReason: (nuqJob ? nuqJob.failedReason : dbScrape!.error) || undefined,
  };

  return job;
}

export async function getJobs(ids: string[]): Promise<PseudoJob<any>[]> {
  const [nuqJobs, dbScrapes, gcsJobs] = await Promise.all([
    scrapeQueue.getJobs(ids) as Promise<NuQJob<ScrapeJobSingleUrls>[]>,
    config.USE_DB_AUTHENTICATION ? supabaseGetScrapesById(ids) : [],
    config.GCS_BUCKET_NAME
      ? (Promise.all(
          ids.map(async x => ({ id: x, job: await getJobFromGCS(x) })),
        ).then(x => x.filter(x => x.job)) as Promise<
          { id: string; job: any | null }[]
        >)
      : [],
  ]);

  const nuqJobMap = new Map<string, NuQJob<any, any>>();
  const dbScrapeMap = new Map<string, DBScrape>();
  const gcsJobMap = new Map<string, any>();

  for (const job of nuqJobs) {
    nuqJobMap.set(job.id, job);
  }

  for (const scrape of dbScrapes) {
    dbScrapeMap.set(scrape.id, scrape);
  }

  for (const job of gcsJobs) {
    gcsJobMap.set(job.id, job.job);
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const nuqJob = nuqJobMap.get(id);
    const dbScrape = dbScrapeMap.get(id);
    const gcsJob = gcsJobMap.get(id);

    if (!nuqJob && !dbScrape) continue;

    const data = gcsJob ?? nuqJob?.returnvalue;
    if (gcsJob === null && data) {
      logger.warn("GCS Job not found", {
        jobId: id,
      });
    }

    const job: PseudoJob<any> = {
      id,
      status: dbScrape
        ? dbScrape.success
          ? "completed"
          : "failed"
        : nuqJob!.status,
      returnvalue: Array.isArray(data) ? data[0] : data,
      data: {
        scrapeOptions: nuqJob ? nuqJob.data.scrapeOptions : dbScrape!.options,
      },
      timestamp: nuqJob
        ? nuqJob.createdAt.valueOf()
        : new Date(dbScrape!.created_at).valueOf(),
      failedReason:
        (nuqJob ? nuqJob.failedReason : dbScrape!.error) || undefined,
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

  const creditsRpc = config.USE_DB_AUTHENTICATION
    ? await supabase_service.rpc(
        "credits_billed_by_crawl_id_2",
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
        ? `${req.protocol}://${req.get("host")}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
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
