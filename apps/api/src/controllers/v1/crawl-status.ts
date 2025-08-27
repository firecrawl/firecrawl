import { Response } from "express";
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
import { getScrapeQueue } from "../../services/queue-service";
import {
  supabaseGetJobById,
  supabaseGetJobsById,
} from "../../lib/supabase-jobs";
import { configDotenv } from "dotenv";
import type { Job, JobState } from "bullmq";
import { logger } from "../../lib/logger";
import { supabase_rr_service, supabase_service } from "../../services/supabase";
import { getJobFromGCS } from "../../lib/gcs-jobs";
configDotenv();

export type PseudoJob<T> = {
  id: string,
  getState(): Promise<JobState | "unknown"> | JobState | "unknown",
  returnvalue: T | null,
  timestamp: number,
  data: {
    scrapeOptions: any,
    teamId?: string,
  },
  failedReason?: string,
}

export type DBJob = { docs: any, success: boolean, page_options: any, date_added: any, message: string | null, team_id: string }

export async function getJob(id: string): Promise<PseudoJob<any> | null> {
  const [bullJob, dbJob, gcsJob] = await Promise.all([
    getScrapeQueue().getJob(id),
    (process.env.USE_DB_AUTHENTICATION === "true" ? supabaseGetJobById(id) : null) as Promise<DBJob | null>,
    (process.env.GCS_BUCKET_NAME ? getJobFromGCS(id) : null) as Promise<any | null>,
  ]);

  if (!bullJob && !dbJob) return null;

  const data = gcsJob ?? dbJob?.docs ?? bullJob?.returnvalue;
  if (gcsJob === null && data) {
    logger.warn("GCS Job not found", {
      jobId: id,
    });
  }

  const job: PseudoJob<any> = {
    id,
    getState: dbJob ? (() => dbJob.success ? "completed" : "failed") : bullJob!.getState,
    returnvalue: Array.isArray(data)
      ? data[0]
      : data,
    data: {
      scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbJob!.page_options,
    },
    timestamp: bullJob ? bullJob.timestamp : new Date(dbJob!.date_added).valueOf(),
    failedReason: (bullJob ? bullJob.failedReason : dbJob!.message) || undefined,
  }

  return job;
}

export async function getJobs(ids: string[]): Promise<PseudoJob<any>[]> {
  const [bullJobs, dbJobs, gcsJobs] = await Promise.all([
    Promise.all(ids.map((x) => getScrapeQueue().getJob(x))).then(x => x.filter(x => x)) as Promise<(Job<any, any, string> & { id: string })[]>,
    process.env.USE_DB_AUTHENTICATION === "true" ? supabaseGetJobsById(ids) : [],
    process.env.GCS_BUCKET_NAME ? Promise.all(ids.map(async (x) => ({ id: x, job: await getJobFromGCS(x) }))).then(x => x.filter(x => x.job)) as Promise<({ id: string, job: any | null })[]> : [],
  ]);

  const bullJobMap = new Map<string, PseudoJob<any>>();
  const dbJobMap = new Map<string, DBJob>();
  const gcsJobMap = new Map<string, any>();

  for (const job of bullJobs) {
    bullJobMap.set(job.id, job);
  }

  for (const job of dbJobs) {
    dbJobMap.set(job.job_id, job);
  }

  for (const job of gcsJobs) {
    gcsJobMap.set(job.id, job.job);
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const bullJob = bullJobMap.get(id);
    const dbJob = dbJobMap.get(id);
    const gcsJob = gcsJobMap.get(id);

    if (!bullJob && !dbJob) continue;

    const data = gcsJob ?? dbJob?.docs ?? bullJob?.returnvalue;
    if (gcsJob === null && data) {
      logger.warn("GCS Job not found", {
        jobId: id,
      });
    }

    const job: PseudoJob<any> = {
      id,
      getState: dbJob ? (() => dbJob.success ? "completed" : "failed") : (() => bullJob!.getState()),
      returnvalue: Array.isArray(data)
        ? data[0]
        : data,
      data: {
        scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbJob!.page_options,
      },
      timestamp: bullJob ? bullJob.timestamp : new Date(dbJob!.date_added).valueOf(),
      failedReason: (bullJob ? bullJob.failedReason : dbJob!.message) || undefined,
    }

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
  
  const sc = await getCrawl(req.params.jobId);

  const djoCutoff = Date.now() - 250;

  if (sc) {
    if (sc.team_id !== req.auth.team_id) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
  } else if (process.env.USE_DB_AUTHENTICATION === "true") {
    const { data: crawlJobs, error: crawlJobError } = await supabase_rr_service
      .from("firecrawl_jobs")
      .select("*")
      .eq("job_id", req.params.jobId)
      .limit(1);

    if (crawlJobError || !crawlJobs || crawlJobs.length === 0) {
      logger.error("Error getting crawl job", { error: crawlJobError });
      throw new Error("Error getting crawl job", { cause: crawlJobError });
    }

    const crawlJob = crawlJobs[0];

    if (crawlJob.team_id !== req.auth.team_id) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    const crawlTtlHours = req.acuc?.flags?.crawlTtlHours ?? 24;
    const crawlTtlMs = crawlTtlHours * 60 * 60 * 1000;

    if (new Date().valueOf() - new Date(crawlJob.date_added).valueOf() > crawlTtlMs) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }
  } else {
    // if SC is gone and no DB, that means the job is expired, or never existed to begin with
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  let outputBulkA: {
    status?: "completed" | "scraping" | "cancelled",
    completed?: number,
    total?: number,
    creditsUsed?: number,
  };

  if (sc) {
    // Local mode (easier, low-pressure)
    const kickoffFinished = await isCrawlKickoffFinished(req.params.jobId);
    let total = await getCrawlQualifiedJobCount(req.params.jobId);

    let completed = await getDoneJobsOrderedLength(req.params.jobId, djoCutoff);
    let creditsUsed = completed * (sc.scrapeOptions?.formats?.find(x => typeof x === "object" && x.type === "json") ? 5 : 1);

    if (process.env.USE_DB_AUTHENTICATION === "true") {
      const creditsRpc = await supabase_service
        .rpc("credits_billed_by_crawl_id_1", {
          i_crawl_id: req.params.jobId,
        }, { get: true });

      creditsUsed = creditsRpc.data?.[0]?.credits_billed ?? creditsUsed;

      if (total === 0 && completed === 0 && Date.now() - sc.createdAt > 1000 * 60) {
        const x = await supabase_service
          .rpc('crawl_status_job_count_1', {
            i_team_id: req.auth.team_id,
            i_crawl_id: req.params.jobId,
          }, { get: true });

        total = x.data?.[0]?.count ?? 0;
        completed = total;
      }
    }

    outputBulkA = {
      status: sc.cancelled ? "cancelled" : (completed === total && kickoffFinished) ? "completed" : "scraping",
      total,
      completed,
      creditsUsed,
    };
  } else { // DB must be specified at this point, otherwise control flow kills execution earlier
    // DB mode (once job expires from Redis)
    const { data: crawlJobCounts, error: crawlJobCountsError } = await supabase_service
      .rpc('crawl_status_job_count_1', {
        i_team_id: req.auth.team_id,
        i_crawl_id: req.params.jobId,
      }, { get: true });

    if (crawlJobCountsError || !crawlJobCounts || crawlJobCounts.length === 0) {
      logger.error("Error getting crawl job count", { error: crawlJobCountsError });
      throw new Error("Error getting crawl job count", { cause: crawlJobCountsError });
    }

    const crawlJobCount: number = crawlJobCounts[0].count ?? 0;

    const creditsRpc = await supabase_service
        .rpc("credits_billed_by_crawl_id_1", {
          i_crawl_id: req.params.jobId,
        }, { get: true });

    const creditsUsed = creditsRpc.data?.[0]?.credits_billed ?? crawlJobCount;

    outputBulkA = {
      status: "completed", // Salvage expired job
      total: crawlJobCount,
      completed: crawlJobCount,
      creditsUsed,
    };
  }

  let outputBulkB: {
    data: Document[],
    next: string | undefined,
  };

  if (process.env.USE_DB_AUTHENTICATION === "true") {
    // new DB-based path
    const { data, error } = await supabase_service.rpc("crawl_status_1", {
      i_team_id: req.auth.team_id,
      i_crawl_id: req.params.jobId,
      i_start: start,
      i_end: end ?? (start + 100),
    }, { get: true });

    if (error || !data) {
      logger.error("Error getting crawl status from DB", { error });
      throw new Error("Error getting crawl status from DB", { cause: error });
    }

    const scrapeIds = data?.map((x) => x.id) ?? [];
    let scrapes: Document[] = [];
    let iteratedOver = 0;
    let bytes = 0;
    const bytesLimit = 10485760; // 10 MiB in bytes

    const scrapeBlobs = await Promise.all(scrapeIds.map(async (x) => [x, (await getJobFromGCS(x))?.[0]]));

    for (const [id, scrape] of scrapeBlobs) {
      if (scrape) {
        scrapes.push(scrape);
        bytes += JSON.stringify(scrape).length;
      } else {
        logger.warn(
          "Job was considered done, but returnvalue is undefined!",
          { jobId: id, returnvalue: scrape },
        );
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
      next: (outputBulkA.total ?? 0) > (start + iteratedOver)
        ? `${process.env.ENV === "local" ? req.protocol : "https"}://${req.get("host")}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
        : undefined,
    };
  } else {
    // old BullMQ-based path
    const doneJobs = await getDoneJobsOrderedUntil(req.params.jobId, djoCutoff, start, end !== undefined ? end - start : 100);

    let scrapes: Document[] = [];
    let iteratedOver = 0;
    let bytes = 0;
    const bytesLimit = 10485760; // 10 MiB in bytes

    for (const jobId of doneJobs) {
      const job = await getScrapeQueue().getJob(jobId);
      const state = await job?.getState();

      if (state === "failed") {
        // no iterated over, just ignore
        continue;
      } else {
        if (job?.returnvalue) {
          scrapes.push(job.returnvalue);
          bytes += JSON.stringify(job.returnvalue).length;
        } else {
          logger.warn(
            "Job was considered done, but returnvalue is undefined!",
            { scrapeId: jobId, crawlId: req.params.jobId, state, returnvalue: job?.returnvalue },
          );
        }

        iteratedOver++;
      }

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
      next: (outputBulkA.total ?? 0) > (start + iteratedOver)
        ? `${process.env.ENV === "local" ? req.protocol : "https"}://${req.get("host")}/v1/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
        : undefined,
    };
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
  });
}
