import { Request, Response } from "express";
import { config } from "../../config";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { redisEvictConnection } from "../../../src/services/redis";
import { logger } from "../../../src/lib/logger";
import { getCrawl, type StoredCrawl } from "../../../src/lib/crawl-redis";
import { configDotenv } from "dotenv";
import { toLegacyDocument } from "../v1/types";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { scrapeQueue, crawlGroup } from "../../services/worker/nuq-router";
import { includesFormat } from "../../lib/format-utils";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
configDotenv();

async function getNuQCrawlStatus(crawlId: string, sc: StoredCrawl) {
  const group = await crawlGroup.getGroup(crawlId);
  const numericStats = await scrapeQueue.getGroupNumericStats(
    crawlId,
    logger.child({ module: "v0-crawl-status" }),
  );

  const completed = numericStats.completed ?? 0;
  const total =
    completed +
    (numericStats.active ?? 0) +
    (numericStats.queued ?? 0) +
    (numericStats.backlog ?? 0);

  const doneJobs =
    completed > 0
      ? await scrapeQueue.getGroupJobs(
          crawlId,
          "completed",
          completed,
          0,
          logger.child({ module: "v0-crawl-status" }),
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

    return res.json(await getNuQCrawlStatus(jobId, sc));
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
