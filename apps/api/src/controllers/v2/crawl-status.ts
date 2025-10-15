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
import { scrapeQueue, NuQJob, NuQJobStatus } from "../../services/worker/nuq";
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
  const isPreviewTeam = req.auth.team_id?.startsWith("preview");
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
      // Allow preview tokens to access preview jobs regardless of IP-derived team_id mismatch
      const scIsPreview = sc.team_id?.startsWith("preview");
      if (!(isPreviewTeam && scIsPreview)) {
        return res.status(404).json({ success: false, error: "Job not found" });
      }
    }
  } else if (process.env.USE_DB_AUTHENTICATION === "true") {
    if (isPreviewTeam) {
      // Preview teams do not persist crawls in DB; avoid DB lookup that can 500
      return res.status(404).json({ success: false, error: "Job not found" });
    }
    const { data: crawlJobs, error: crawlJobError } = await supabase_rr_service
      .from("firecrawl_jobs")
      .select("*")
      .eq("job_id", req.params.jobId)
      .limit(1);

    let crawlAdded: Date;
    let crawlTeamId: string;

    if (crawlJobError || !crawlJobs || crawlJobs.length === 0) {
      const { data: scrapeJobs, error: scrapeJobError } =
        await supabase_rr_service
          .from("firecrawl_jobs")
          .select("*")
          .eq("crawl_id", req.params.jobId)
          .order("date_added", { ascending: false })
          .limit(1);

      if (scrapeJobError || !scrapeJobs || scrapeJobs.length === 0) {
        return res.status(404).json({ success: false, error: "Job not found" });
      }

      const scrapeJob = scrapeJobs[0];
      crawlAdded = new Date(scrapeJob.date_added); // use last scrape as date added for crawl
      crawlTeamId = scrapeJob.team_id;
    } else {
      const crawlJob = crawlJobs[0];
      crawlAdded = new Date(crawlJob.date_added);
      crawlTeamId = crawlJob.team_id;
    }

    if (crawlTeamId !== req.auth.team_id) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    const crawlTtlHours = req.acuc?.flags?.crawlTtlHours ?? 24;
    const crawlTtlMs = crawlTtlHours * 60 * 60 * 1000;

    if (new Date().valueOf() - crawlAdded.valueOf() > crawlTtlMs) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }
  } else {
    // if SC is gone and no DB, that means the job is expired, or never existed to begin with
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  let outputBulkA: {
    status?: "completed" | "scraping" | "cancelled";
    completed?: number;
    total?: number;
    creditsUsed?: number;
  };

  if (sc) {
    // Local mode (easier, low-pressure)
    const kickoffFinished = await isCrawlKickoffFinished(req.params.jobId);
    let total = await getCrawlQualifiedJobCount(req.params.jobId);

    let completed = await getDoneJobsOrderedLength(req.params.jobId, djoCutoff);
    let creditsUsed =
      completed *
      (sc.scrapeOptions?.formats?.find(
        x => typeof x === "object" && x.type === "json",
      )
        ? 5
        : 1);

    if (process.env.USE_DB_AUTHENTICATION === "true" && !isPreviewTeam) {
      const creditsRpc = await supabase_service.rpc(
        "credits_billed_by_crawl_id_1",
        {
          i_crawl_id: req.params.jobId,
        },
        { get: true },
      );

      creditsUsed = creditsRpc.data?.[0]?.credits_billed ?? creditsUsed;

      if (
        total === 0 &&
        completed === 0 &&
        Date.now() - sc.createdAt > 1000 * 60
      ) {
        const x = await supabase_service.rpc(
          "crawl_status_job_count_1",
          {
            i_team_id: req.auth.team_id,
            i_crawl_id: req.params.jobId,
          },
          { get: true },
        );

        total = x.data?.[0]?.count ?? 0;
        completed = total;
      }
    }

    outputBulkA = {
      status: sc.cancelled
        ? "cancelled"
        : completed === total && kickoffFinished
          ? "completed"
          : "scraping",
      total,
      completed,
      creditsUsed,
    };
  } else {
    // DB must be specified at this point, otherwise control flow kills execution earlier
    // DB mode (once job expires from Redis)
    const { data: crawlJobCounts, error: crawlJobCountsError } =
      await supabase_service.rpc(
        "crawl_status_job_count_1",
        {
          i_team_id: req.auth.team_id,
          i_crawl_id: req.params.jobId,
        },
        { get: true },
      );

    if (crawlJobCountsError || !crawlJobCounts || crawlJobCounts.length === 0) {
      logger.error("Error getting crawl job count", {
        error: crawlJobCountsError,
      });
      throw new Error("Error getting crawl job count", {
        cause: crawlJobCountsError,
      });
    }

    const crawlJobCount: number = crawlJobCounts[0].count ?? 0;

    const creditsRpc = await supabase_service.rpc(
      "credits_billed_by_crawl_id_1",
      {
        i_crawl_id: req.params.jobId,
      },
      { get: true },
    );

    const creditsUsed = creditsRpc.data?.[0]?.credits_billed ?? crawlJobCount;

    outputBulkA = {
      status: "completed", // Salvage expired job
      total: crawlJobCount,
      completed: crawlJobCount,
      creditsUsed,
    };
  }

  let outputBulkB: {
    data: Document[];
    next: string | undefined;
  };

  if (sc || process.env.USE_DB_AUTHENTICATION !== "true" || isPreviewTeam) {
    const doneJobs = await getDoneJobsOrderedUntil(
      req.params.jobId,
      djoCutoff,
      start,
      end !== undefined ? end - start : 100,
    );

    let scrapes: Document[] = [];
    let iteratedOver = 0;
    let bytes = 0;
    const bytesLimit = 10485760; // 10 MiB in bytes

    for (let i = 0; i < Math.ceil(doneJobs.length / 50); i++) {
      const jobIds = doneJobs.slice(i * 50, (i + 1) * 50);
      const jobs = await getJobs(jobIds, logger);

      for (const job of jobs) {
        if (job.status === "failed") {
          continue;
        } else {
          if (job?.returnvalue) {
            scrapes.push(job.returnvalue);
            bytes += JSON.stringify(job.returnvalue).length;
          } else {
            logger.warn(
              "Job was considered done, but returnvalue is undefined!",
              {
                scrapeId: job.id,
                crawlId: req.params.jobId,
                state: job.status,
                returnvalue: job?.returnvalue,
              },
            );
          }

          iteratedOver++;
        }

        if (bytes > bytesLimit) {
          break;
        }
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
      next:
        (outputBulkA.total ?? 0) > start + iteratedOver
          ? `${process.env.ENV === "local" ? req.protocol : "https"}://${req.get("host")}/v2/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
          : undefined,
    };
  } else {
    // new DB-based path
    const { data, error } = await supabase_service.rpc(
      "crawl_status_1",
      {
        i_team_id: req.auth.team_id,
        i_crawl_id: req.params.jobId,
        i_start: start,
        i_end: end ?? start + 100,
      },
      { get: true },
    );

    if (error || !data) {
      logger.error("Error getting crawl status from DB", { error });
      throw new Error("Error getting crawl status from DB", { cause: error });
    }

    const scrapeIds = data?.map(x => x.id) ?? [];
    let scrapes: Document[] = [];
    let iteratedOver = 0;
    let bytes = 0;
    const bytesLimit = 10485760; // 10 MiB in bytes

    const scrapeBlobs = await Promise.all(
      scrapeIds.map(async x => [x, (await getJobFromGCS(x))?.[0]]),
    );

    for (const [id, scrape] of scrapeBlobs) {
      if (scrape) {
        scrapes.push(scrape);
        bytes += JSON.stringify(scrape).length;
      } else {
        logger.warn("Job was considered done, but returnvalue is undefined!", {
          jobId: id,
          returnvalue: scrape,
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
        (outputBulkA.total ?? 0) > start + iteratedOver
          ? `${process.env.ENV === "local" ? req.protocol : "https"}://${req.get("host")}/v2/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
          : undefined,
    };
  }

  // Check for robots.txt blocked URLs and add warning if found
  let warning: string | undefined;
  try {
    const robotsBlocked = await redisEvictConnection.smembers(
      "crawl:" + req.params.jobId + ":robots_blocked",
    );
    if (robotsBlocked && robotsBlocked.length > 0) {
      warning =
        "One or more pages were unable to be crawled because the robots.txt file prevented this. Please use the /scrape endpoint instead.";
    }
  } catch (error) {
    // If we can't check robots blocked URLs, continue without warning
    logger.debug("Failed to check robots blocked URLs", { error });
  }

  // Check if we should warn about base domain for crawl results
  const resultCount = outputBulkA.completed ?? outputBulkA.total ?? outputBulkB.data.length;
  if (!warning && resultCount <= 1) {
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
