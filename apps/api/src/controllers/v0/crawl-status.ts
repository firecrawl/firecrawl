import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { getScrapeQueue } from "../../../src/services/queue-service";
import { redisEvictConnection } from "../../../src/services/redis";
import { logger } from "../../../src/lib/logger";
import { getCrawl, getCrawlJobs } from "../../../src/lib/crawl-redis";
import { supabaseGetJobsByCrawlId } from "../../../src/lib/supabase-jobs";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { Job } from "bullmq";
import { toLegacyDocument } from "../v1/types";
import type { DBJob, PseudoJob } from "../v1/crawl-status";
import { getJobFromGCS } from "../../lib/gcs-jobs";
configDotenv();

export async function getJobs(crawlId: string, ids: string[]): Promise<PseudoJob<any>[]> {
   const [bullJobs, dbJobs, gcsJobs] = await Promise.all([
      Promise.all(ids.map((x) => getScrapeQueue().getJob(x))).then(x => x.filter(x => x)) as Promise<(Job<any, any, string> & { id: string })[]>,
      process.env.USE_DB_AUTHENTICATION === "true" ? await supabaseGetJobsByCrawlId(crawlId) : [],
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

export async function crawlStatusController(req: Request, res: Response) {
  try {
    const auth = await authenticateUser(req, res, RateLimiterMode.CrawlStatus);
    if (!auth.success) {
      return res.status(auth.status).json({ error: auth.error });
    }

    if (auth.chunk?.flags?.forceZDR) {
      return res.status(400).json({ error: "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API." });
    }

    const { team_id } = auth;

    redisEvictConnection.sadd("teams_using_v0", team_id)
      .catch(error => logger.error("Failed to add team to teams_using_v0", { error, team_id }));
    
    redisEvictConnection.sadd("teams_using_v0:" + team_id, "crawl:" + req.params.jobId + ":status")
      .catch(error => logger.error("Failed to add team to teams_using_v0 (2)", { error, team_id }));

    const sc = await getCrawl(req.params.jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (sc.team_id !== team_id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    let jobIDs = await getCrawlJobs(req.params.jobId);
    let jobs = await getJobs(req.params.jobId, jobIDs);
    let jobStatuses = await Promise.all(jobs.map((x) => x.getState()));

    // Combine jobs and jobStatuses into a single array of objects
    let jobsWithStatuses = jobs.map((job, index) => ({
      job,
      status: jobStatuses[index],
    }));

    // Filter out failed jobs
    jobsWithStatuses = jobsWithStatuses.filter(
      (x) => x.status !== "failed" && x.status !== "unknown",
    );

    // Sort jobs by timestamp
    jobsWithStatuses.sort((a, b) => a.job.timestamp - b.job.timestamp);

    // Extract sorted jobs and statuses
    jobs = jobsWithStatuses.map((x) => x.job);
    jobStatuses = jobsWithStatuses.map((x) => x.status);

    const jobStatus = sc.cancelled
      ? "failed"
      : jobStatuses.every((x) => x === "completed")
        ? "completed"
        : "active";

    const data = jobs
      .filter(
        (x) =>
          x.failedReason !== "Concurreny limit hit" && x.returnvalue !== null,
      )
      .map((x) =>
        Array.isArray(x.returnvalue) ? x.returnvalue[0] : x.returnvalue,
      );

    if (
      jobs.length > 0 &&
      jobs[0].data &&
      jobs[0].data.scrapeOptions &&
      jobs[0].data.scrapeOptions.formats &&
      !jobs[0].data.scrapeOptions.formats.includes("rawHtml")
    ) {
      data.forEach((item) => {
        if (item) {
          delete item.rawHtml;
        }
      });
    }

    res.json({
      status: jobStatus,
      current: jobStatuses.filter((x) => x === "completed" || x === "failed")
        .length,
      total: jobs.length,
      data:
        jobStatus === "completed"
          ? data.map((x) => toLegacyDocument(x, sc.internalOptions))
          : null,
      partial_data:
        jobStatus === "completed"
          ? []
          : data
              .filter((x) => x !== null)
              .map((x) => toLegacyDocument(x, sc.internalOptions)),
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
