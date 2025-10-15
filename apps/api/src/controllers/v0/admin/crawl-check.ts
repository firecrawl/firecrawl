import { Request, Response } from "express";
import { redisEvictConnection } from "../../../services/redis";
import {
  getCrawl,
  isCrawlKickoffFinished,
  StoredCrawl,
} from "../../../lib/crawl-redis";
import { supabase_service } from "../../../services/supabase";
import { getConcurrencyLimitedJobs } from "../../../lib/concurrency-limit";
import { scrapeQueue } from "../../../services/worker/nuq";

type AnalyzedCrawlPass1 = {
  success: true;
  id: string;
  teamId: string;
  crawl: StoredCrawl | null;
  latestJob: any[];
  overarchingJob: any[];
  jobsDoneCount: number;
  jobsCount: number;
  jobsNotDone: Set<string>;
};

type AnalyzedCrawlPass2 = {
  success: true;
  id: string;
  status:
    | "stuck_other"
    | "stuck_stalled"
    | "stuck_delay"
    | "working"
    | "finished";
  outstandingJobs: string[];
  jobs: {
    total: number;
    done: number;
    pending: number;
    queued: number;
    concurrencyQueued: number;
    outstanding: number;
  };
  kickoffDone: boolean;
  type: "crawl" | "batch_scrape" | "not_sure";
  teamId: string;

  createdAt: string;
  updatedAt: string;
};

type AnalyzedCrawlError = {
  success: false;
  id: string;
  error: string;
};

async function analyzeCrawlPass1(
  id: string,
): Promise<AnalyzedCrawlPass1 | AnalyzedCrawlError> {
  const crawl = await getCrawl(id);

  if (crawl?.zeroDataRetention) {
    return {
      success: false,
      id,
      error: "Zero Data Retention is enabled for this crawl",
    };
  }

  const { data: latestJob, error: latestJobError } = await supabase_service
    .from("firecrawl_jobs")
    .select("*")
    .eq("crawl_id", id)
    .order("date_added", { ascending: false })
    .limit(1);

  const { data: overarchingJob, error: overarchingJobError } =
    await supabase_service
      .from("firecrawl_jobs")
      .select("*")
      .eq("job_id", id)
      .limit(1);

  if (latestJobError || overarchingJobError) {
    return {
      success: false,
      id,
      error:
        latestJobError?.message ??
        overarchingJobError?.message ??
        "unknown error",
    };
  }

  const jobsDoneCount = await redisEvictConnection.scard(
    "crawl:" + id + ":jobs_done",
  );
  const jobsCount = await redisEvictConnection.scard("crawl:" + id + ":jobs");

  // job IDs that are not done
  const jobsNotDone = new Set(
    await redisEvictConnection.sdiff(
      "crawl:" + id + ":jobs",
      "crawl:" + id + ":jobs_done",
    ),
  );

  return {
    success: true,
    id,
    crawl,
    latestJob,
    overarchingJob,
    jobsDoneCount,
    jobsCount,
    jobsNotDone,
    teamId:
      crawl?.team_id ??
      latestJob[0].team_id ??
      overarchingJob[0].team_id ??
      "unknown",
  };
}

async function analyzeCrawlPass2(
  {
    id,
    teamId,
    crawl,
    latestJob,
    overarchingJob,
    jobsDoneCount,
    jobsCount,
    jobsNotDone,
  }: AnalyzedCrawlPass1,
  teamConcurrencyQueuedJobs: Set<string>,
): Promise<AnalyzedCrawlPass2 | AnalyzedCrawlError> {
  const jobsNotDoneNorConcurrencyQueued = new Set(
    [...jobsNotDone].filter(jobId => !teamConcurrencyQueuedJobs.has(jobId)),
  );

  const jobsInQueue = await scrapeQueue.getJobs(
    Array.from(jobsNotDoneNorConcurrencyQueued),
  );

  const jobsInQueueQueued = new Set(
    jobsInQueue
      .filter(job => job.status === "queued" || job.status === "active")
      .map(job => job.id),
  );
  const jobsInQueueStalled = new Set(
    jobsInQueue
      .filter(job => job.status === "failed" && job.failedReason === null)
      .map(job => job.id),
  );

  const jobsNotDoneNorConcurrencyQueuedNorInQueue = new Set(
    [...jobsNotDoneNorConcurrencyQueued].filter(
      jobId => !jobsInQueueQueued.has(jobId),
    ),
  );

  return {
    success: true,
    id,
    teamId,
    status: overarchingJob[0]
      ? "finished"
      : jobsNotDoneNorConcurrencyQueuedNorInQueue.size === 0
        ? "working"
        : (
              crawl?.crawlerOptions ??
              overarchingJob[0]?.crawler_options ??
              latestJob[0]?.crawler_options
            )?.delay > 0
          ? "stuck_delay"
          : jobsInQueueStalled.size > 0
            ? "stuck_stalled"
            : "stuck_other",
    kickoffDone: await isCrawlKickoffFinished(id),
    jobs: {
      total: jobsCount,
      done: jobsDoneCount,
      pending: jobsCount - jobsDoneCount,
      queued: jobsInQueueQueued.size,
      concurrencyQueued: [...jobsNotDone].filter(jobId =>
        teamConcurrencyQueuedJobs.has(jobId),
      ).length,
      outstanding: jobsNotDoneNorConcurrencyQueuedNorInQueue.size,
    },
    outstandingJobs: Array.from(jobsNotDoneNorConcurrencyQueuedNorInQueue),
    type: overarchingJob[0]
      ? overarchingJob[0].crawler_options !== null
        ? "crawl"
        : "batch_scrape"
      : latestJob[0]
        ? latestJob[0].crawler_options !== null
          ? "crawl"
          : "batch_scrape"
        : crawl
          ? crawl.crawlerOptions !== null
            ? "crawl"
            : "batch_scrape"
          : "not_sure",
    createdAt: new Date(crawl?.createdAt ?? 0).toISOString(),
    updatedAt: new Date(
      overarchingJob[0]?.date_added ??
        latestJob[0]?.date_added ??
        crawl?.createdAt ??
        0,
    ).toISOString(),
  };
}

export async function crawlCheckController(req: Request, res: Response) {
  const activeCrawls = await redisEvictConnection.smembers("active_crawls");
  const firstPass = (
    await Promise.all(activeCrawls.map(analyzeCrawlPass1))
  ).filter(result => result.success);

  const teamIds = [...new Set(firstPass.map(result => result.teamId))];
  const teamConcurrencyQueuedJobs = Object.fromEntries(
    await Promise.all(
      teamIds.map(async teamId => [
        teamId,
        await getConcurrencyLimitedJobs(teamId),
      ]),
    ),
  );

  const results = await Promise.all(
    firstPass.map(result =>
      analyzeCrawlPass2(
        { ...result },
        teamConcurrencyQueuedJobs[result.teamId],
      ),
    ),
  );

  // Clean results which should be "solved"
  const solvedBatchScrapeZeroURLs = results.filter(
    result =>
      result.success &&
      result.type === "batch_scrape" &&
      result.jobs.total === 0,
  );
  // if (solvedBatchScrapeZeroURLs.length > 0) {
  //   await redisEvictConnection.srem("active_crawls", solvedBatchScrapeZeroURLs.map(result => result.id));
  // }

  res.status(200).json({
    count: results.length,
    perTeam: results.reduce(
      (acc, result) => {
        if (result.success) {
          if (!acc[result.teamId]) {
            acc[result.teamId] = {} as Record<
              AnalyzedCrawlPass2["status"],
              number
            >;
          }
          acc[result.teamId][result.status] =
            (acc[result.teamId][result.status] ?? 0) + 1;
        }
        return acc;
      },
      {} as Record<string, Record<AnalyzedCrawlPass2["status"], number>>,
    ),
    perSymptom: {
      batchScrapeZeroURLs: solvedBatchScrapeZeroURLs.length,
    },
    results,
  });
}
