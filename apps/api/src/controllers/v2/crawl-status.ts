import { Response } from "express";
import {
  CrawlStatusParams,
  CrawlStatusResponse,
  RequestWithAuth,
  Document,
} from "./types";
import {
  getCrawl,
  getCrawlError,
  getCrawlExpiry,
  getCrawlQualifiedJobCount,
  getDoneJobsOrderedLength,
  getDoneJobsOrderedUntil,
  getLastDoneJobTimestamp,
  isCrawlKickoffFinished,
  getCrawlRobotsBlockedCount,
} from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { logger } from "../../lib/logger";
import {
  scrapeQueue,
  NuQJob,
  NuQJobStatus,
  crawlGroup,
} from "../../services/worker/nuq-router";
import { ScrapeJobSingleUrls } from "../../types";
import { isBaseDomain, extractBaseDomain } from "../../lib/url-utils";
import { storedZeroDataRetention } from "../../lib/request-context";
import { service, type StoredJob } from "../../service";
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

const JOB_STORE_READ_CONCURRENCY = 20;

async function readStoredJobs(
  ids: readonly string[],
): Promise<Map<string, StoredJob>> {
  if (ids.length === 0) return new Map();
  const store = service.modules.jobStore;
  if (store.readMany) {
    return store.readMany(ids, "scrape");
  }
  const result = new Map<string, StoredJob>();
  for (let i = 0; i < ids.length; i += JOB_STORE_READ_CONCURRENCY) {
    const batch = ids.slice(i, i + JOB_STORE_READ_CONCURRENCY);
    const entries = await Promise.all(
      batch.map(async id => [id, await store.read(id, "scrape")] as const),
    );
    for (const [id, job] of entries) {
      if (job) result.set(id, job);
    }
  }
  return result;
}

export async function getJob(
  id: string,
  _logger = logger,
): Promise<PseudoJob<any> | null> {
  const store = service.modules.jobStore;
  const externalStore = store.storesResultsExternally?.() ?? false;
  let storeReadError: unknown = null;
  const readStore = () =>
    store.read(id, "scrape").catch(error => {
      _logger.warn("Job store read failed", {
        error,
        scrapeId: id,
      });
      storeReadError = error;
      return null;
    });

  let nuqJob: NuQJob<ScrapeJobSingleUrls> | null;
  let stored: StoredJob | null = null;
  if (externalStore) {
    [nuqJob, stored] = await Promise.all([
      scrapeQueue.getJob(
        id,
        _logger,
      ) as Promise<NuQJob<ScrapeJobSingleUrls> | null>,
      readStore(),
    ]);
  } else {
    nuqJob = (await scrapeQueue.getJob(
      id,
      _logger,
    )) as NuQJob<ScrapeJobSingleUrls> | null;
    if (!nuqJob) {
      stored = await readStore();
    }
  }

  if (!nuqJob && !stored) {
    if (storeReadError) throw storeReadError;
    return null;
  }

  if (nuqJob && nuqJob.data && nuqJob.data.mode !== "single_urls") {
    return null;
  }

  if (
    !stored?.document &&
    storeReadError &&
    service.modules.jobStore.storesResultsExternally?.() &&
    nuqJob?.status === "completed" &&
    !nuqJob.returnvalue
  ) {
    throw storeReadError;
  }

  const data = stored?.document ?? nuqJob?.returnvalue;

  const job: PseudoJob<any> = {
    id,
    status: stored?.state ?? nuqJob!.status,
    returnvalue: Array.isArray(data) ? data[0] : data,
    data: {
      scrapeOptions: nuqJob?.data ? nuqJob.data.scrapeOptions : null,
    },
    timestamp:
      stored?.completedAtMs ?? nuqJob?.createdAt.valueOf() ?? Date.now(),
    failedReason: (stored?.error ?? nuqJob?.failedReason) || undefined,
  };

  return job;
}

export async function getJobs(
  ids: string[],
  _logger = logger,
): Promise<PseudoJob<any>[]> {
  const fetchExternal = Boolean(
    service.modules.jobStore.storesResultsExternally?.(),
  );
  const [nuqJobs, externalJobs] = await Promise.all([
    scrapeQueue.getJobs(ids, _logger) as Promise<NuQJob<ScrapeJobSingleUrls>[]>,
    fetchExternal
      ? readStoredJobs(ids)
      : Promise.resolve(new Map<string, StoredJob>()),
  ]);

  const nuqJobMap = new Map<string, NuQJob<any, any>>();
  for (const job of nuqJobs) {
    nuqJobMap.set(job.id, job);
  }

  let storedJobMap = externalJobs;
  if (!fetchExternal) {
    const missingIds = nuqJobs
      .filter(job => job.status === "completed" && job.returnvalue == null)
      .map(job => job.id);
    if (missingIds.length > 0) {
      storedJobMap = await readStoredJobs(missingIds);
    }
  }

  const jobs: PseudoJob<any>[] = [];

  for (const id of ids) {
    const nuqJob = nuqJobMap.get(id);
    const storedJob = storedJobMap.get(id);

    if (!nuqJob) continue;

    const data = storedJob?.document ?? nuqJob.returnvalue;

    const job: PseudoJob<any> = {
      id,
      status: nuqJob.status,
      returnvalue: Array.isArray(data) ? data[0] : data,
      data: {
        scrapeOptions: nuqJob.data?.scrapeOptions ?? null,
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
    storedZeroDataRetention(groupAnyJob?.data) ?? storedZeroDataRetention(sc)
  );

  const numericStats = await scrapeQueue.getGroupNumericStats(
    req.params.jobId,
    logger.child({ zeroDataRetention }),
  );

  const creditsBilled = await service.modules.jobStore.usage(
    sc?.requestId ?? req.params.jobId,
    { emptyAsZero: true },
  );

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
    const createdAtMs = sc?.createdAt;
    return res.status(200).json({
      success: false,
      error: crawlError,
      status: "failed",
      completed: 0,
      total: 0,
      creditsUsed: outputBulkA.creditsUsed ?? 0,
      expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
      data: [],
      ...(createdAtMs && {
        createdAt: new Date(createdAtMs).toISOString(),
        completedAt: new Date(createdAtMs).toISOString(),
        duration: 0,
      }),
    });
  }

  let outputBulkB: {
    data: Document[];
    next: string | undefined;
  };

  const pageSize = end !== undefined ? end - start + 1 : 100;
  const doneJobs = await scrapeQueue.getGroupJobs(
    req.params.jobId,
    "completed",
    pageSize,
    start,
    logger.child({ zeroDataRetention }),
  );

  let scrapes: Document[] = [];
  let iteratedOver = 0;
  let bytes = 0;
  const bytesLimit = 10485760; // 10 MiB in bytes

  const missingIds = doneJobs.filter(x => x.returnvalue == null).map(x => x.id);
  const storedById = await readStoredJobs(missingIds);
  const scrapeBlobs = doneJobs.map(
    x => [x.id, x.returnvalue ?? storedById.get(x.id)?.document] as const,
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
    // Only completed documents are paged, so a finished job's cursor ends after
    // its last one. `completed` is read before this page, so a full or
    // size-capped page keeps the cursor for jobs that finished meanwhile.
    next:
      outputBulkA.status === "scraping" ||
      (outputBulkA.completed ?? 0) > start + iteratedOver ||
      doneJobs.length > iteratedOver ||
      (outputBulkA.status !== "completed" &&
        doneJobs.length > 0 &&
        doneJobs.length === pageSize)
        ? `${req.protocol}://${req.host}/v2/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}?skip=${start + iteratedOver}${req.query.limit ? `&limit=${req.query.limit}` : ""}`
        : undefined,
  };

  // Check for robots.txt blocked URLs and add warning if found
  let warning: string | undefined;
  try {
    const rbCount = await getCrawlRobotsBlockedCount(req.params.jobId);
    // Emit as separate simple logs so no meta is lost in sinks
    const statusNow = outputBulkA.status ?? "scraping";
    if (rbCount > 0 && statusNow !== "scraping") {
      warning = `One or more pages could not be crawled because the site's robots.txt disallows them. See the robotsBlocked list on GET /v2/${isBatch ? "batch/scrape" : "crawl"}/${req.params.jobId}/errors. Teams with the feature enabled can set ignoreRobotsTxt: true.`;
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

  const status = outputBulkA.status ?? "scraping";
  const createdAtMs = sc?.createdAt;
  const lastDoneMs =
    status !== "scraping"
      ? await getLastDoneJobTimestamp(req.params.jobId)
      : null;
  const completedAtMs =
    status === "completed" || status === "failed" || status === "cancelled"
      ? (lastDoneMs ?? createdAtMs ?? null)
      : null;
  const durationSeconds = createdAtMs
    ? Math.max(0, ((completedAtMs ?? Date.now()) - createdAtMs) / 1000)
    : undefined;

  return res.status(200).json({
    success: true,
    status,
    completed: outputBulkA.completed ?? 0,
    total: outputBulkA.total ?? 0,
    creditsUsed: outputBulkA.creditsUsed ?? 0,
    expiresAt: (await getCrawlExpiry(req.params.jobId)).toISOString(),
    next: outputBulkB.next,
    data: outputBulkB.data,
    ...(createdAtMs && { createdAt: new Date(createdAtMs).toISOString() }),
    ...(completedAtMs && {
      completedAt: new Date(completedAtMs).toISOString(),
    }),
    ...(durationSeconds !== undefined && { duration: durationSeconds }),
    ...(warning && { warning }),
  });
}
