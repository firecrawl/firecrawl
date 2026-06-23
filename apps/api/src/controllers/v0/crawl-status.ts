import { Request, Response } from "express";
import { config } from "../../config";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { redisEvictConnection } from "../../../src/services/redis";
import { logger } from "../../../src/lib/logger";
import {
  getCrawl,
  getCrawlJobs,
  type StoredCrawl,
} from "../../../src/lib/crawl-redis";
import { supabaseGetScrapesByRequestId } from "../../../src/lib/supabase-jobs";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { toLegacyDocument } from "../v1/types";
import type { DBScrape, PseudoJob } from "../v1/crawl-status";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import {
  scrapeQueue,
  NuQJob,
  crawlGroup,
} from "../../services/worker/nuq-router";
import { includesFormat } from "../../lib/format-utils";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
configDotenv();

async function getJobs(
  crawlId: string,
  ids: string[],
): Promise<PseudoJob<any>[]> {
  const [nuqJobs, dbScrapes, gcsJobs] = await Promise.all([
    scrapeQueue.getJobs(ids),
    config.USE_DB_AUTHENTICATION
      ? await supabaseGetScrapesByRequestId(crawlId)
      : [],
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

async function getFdbCrawlStatus(crawlId: string, sc: StoredCrawl) {
  const group = await crawlGroup.getGroup(crawlId);
  const numericStats = await scrapeQueue.getGroupNumericStats(
    crawlId,
    logger.child({ module: "v0-crawl-status", backend: "fdb" }),
  );

  const completed = numericStats.completed ?? 0;
  const total =
    completed +
    (numericStats.active ?? 0) +
    (numericStats.queued ?? 0) +
    (numericStats.backlog ?? 0);

  const doneJobs =
    completed > 0
      ? await scrapeQueue.getCrawlJobsForListing(
          crawlId,
          completed,
          0,
          logger.child({ module: "v0-crawl-status", backend: "fdb" }),
        )
      : [];

  const scrapeBlobs = await Promise.all(
    doneJobs.map(
      async x =>
        [
          x,
          x.returnvalue ??
            (config.GCS_BUCKET_NAME ? await getJobFromGCS(x.id) : null),
        ] as const,
    ),
  );

  const data = scrapeBlobs
    .filter(
      ([job, scrape]) =>
        job.failedReason !== "Concurreny limit hit" && scrape != null,
    )
    .map(([, scrape]) => (Array.isArray(scrape) ? scrape[0] : scrape));

  const firstScrapeOptions =
    doneJobs.length > 0 && "scrapeOptions" in doneJobs[0].data
      ? doneJobs[0].data.scrapeOptions
      : undefined;

  if (
    firstScrapeOptions?.formats &&
    !includesFormat(firstScrapeOptions.formats, "rawHtml")
  ) {
    data.forEach(item => {
      if (item) {
        delete item.rawHtml;
      }
    });
  }

  const jobStatus = sc.cancelled
    ? "failed"
    : group?.status === "completed"
      ? "completed"
      : "active";

  return {
    status: jobStatus,
    current: completed,
    total,
    data:
      jobStatus === "completed"
        ? data.map(x => toLegacyDocument(x, sc.internalOptions))
        : null,
    partial_data:
      jobStatus === "completed"
        ? []
        : data
            .filter(x => x !== null)
            .map(x => toLegacyDocument(x, sc.internalOptions)),
  };
}

export async function crawlStatusController(req: Request, res: Response) {
  try {
    const jobId = req.params.jobId;
    if (typeof jobId !== "string") {
      return res.status(400).json({ error: "Invalid job ID" });
    }

    const auth = await authenticateUser(req, res, RateLimiterMode.CrawlStatus);
    if (!auth.success) {
      if (auth.status === 401) applyAgentAuthDiscoveryHeader(res);
      return res.status(auth.status).json({ error: auth.error });
    }

    if (getScrapeZDR(auth.chunk?.flags) === "forced") {
      return res.status(400).json({
        error:
          "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API.",
      });
    }

    const { team_id } = auth;

    redisEvictConnection.sadd("teams_using_v0", team_id).catch(error =>
      logger.error("Failed to add team to teams_using_v0", {
        error,
        team_id,
      }),
    );

    redisEvictConnection
      .sadd("teams_using_v0:" + team_id, "crawl:" + jobId + ":status")
      .catch(error =>
        logger.error("Failed to add team to teams_using_v0 (2)", {
          error,
          team_id,
        }),
      );

    const sc = await getCrawl(jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (sc.team_id !== team_id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (sc.queueBackend === "fdb") {
      return res.json(await getFdbCrawlStatus(jobId, sc));
    }

    let jobIDs = await getCrawlJobs(jobId);
    let jobs = await getJobs(jobId, jobIDs);
    let jobStatuses = jobs.map(x => x.status);

    // Combine jobs and jobStatuses into a single array of objects
    let jobsWithStatuses = jobs.map((job, index) => ({
      job,
      status: jobStatuses[index],
    }));

    // Filter out failed jobs
    jobsWithStatuses = jobsWithStatuses.filter(x => x.status !== "failed");

    // Sort jobs by timestamp
    jobsWithStatuses.sort((a, b) => a.job.timestamp - b.job.timestamp);

    // Extract sorted jobs and statuses
    jobs = jobsWithStatuses.map(x => x.job);
    jobStatuses = jobsWithStatuses.map(x => x.status);

    const jobStatus = sc.cancelled
      ? "failed"
      : jobStatuses.every(x => x === "completed")
        ? "completed"
        : "active";

    const data = jobs
      .filter(
        x =>
          x.failedReason !== "Concurreny limit hit" && x.returnvalue !== null,
      )
      .map(x =>
        Array.isArray(x.returnvalue) ? x.returnvalue[0] : x.returnvalue,
      );

    if (
      jobs.length > 0 &&
      jobs[0].data &&
      jobs[0].data.scrapeOptions &&
      jobs[0].data.scrapeOptions.formats &&
      !includesFormat(jobs[0].data.scrapeOptions.formats, "rawHtml")
    ) {
      data.forEach(item => {
        if (item) {
          delete item.rawHtml;
        }
      });
    }

    res.json({
      status: jobStatus,
      current: jobStatuses.filter(x => x === "completed" || x === "failed")
        .length,
      total: jobs.length,
      data:
        jobStatus === "completed"
          ? data.map(x => toLegacyDocument(x, sc.internalOptions))
          : null,
      partial_data:
        jobStatus === "completed"
          ? []
          : data
              .filter(x => x !== null)
              .map(x => toLegacyDocument(x, sc.internalOptions)),
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
