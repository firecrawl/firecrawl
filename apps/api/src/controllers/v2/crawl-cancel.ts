import type { Response } from "express";
import { logger } from "../../lib/logger";
import type { StoredCrawl } from "../../lib/crawl-redis";
import { getCrawl, getCrawlJobs, saveCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import type { RequestWithAuth } from "./types";
import { scrapeOptions } from "./types";
import { crawlGroup } from "../../services/worker/nuq-router";
import { normalizeOwnerId } from "../../lib/owner-id";
import { removeConcurrencyLimitedJobs } from "../../lib/concurrency-limit";
configDotenv();

export async function crawlCancelController(
  req: RequestWithAuth<{ jobId: string }>,
  res: Response,
) {
  try {
    const group = await crawlGroup.getGroup(req.params.jobId);
    if (!group) {
      return res.status(404).json({ error: "Job not found" });
    }

    // group.ownerId is normalized to a UUID in NuQ, so the raw team_id
    // (e.g. "bypass" when self-hosted) must be normalized before comparing
    if (group.ownerId !== normalizeOwnerId(req.auth.team_id)) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (group.status === "completed") {
      return res.status(409).json({ error: "Crawl is already completed" });
    }

    const sc: StoredCrawl = (await getCrawl(req.params.jobId)) ?? {
      team_id: req.auth.team_id,
      createdAt: Date.now(),
      crawlerOptions: null,
      scrapeOptions: scrapeOptions.parse({}),
      internalOptions: {
        teamId: req.auth.team_id,
        orgId: req.acuc?.org_id ?? null,
      },
    };

    let saveError: unknown;
    let failedToPersist = false;
    try {
      sc.cancelled = true;
      await saveCrawl(req.params.jobId, sc);
    } catch (error: unknown) {
      saveError = error;
      failedToPersist = true;
      logger.error("Failed to persist crawl cancellation", {
        error,
        jobId: req.params.jobId,
      });
    }

    if (sc.queueBackend === "fdb") {
      await crawlGroup.cancelGroup(req.params.jobId);
    } else {
      const jobIds = await getCrawlJobs(req.params.jobId);
      await removeConcurrencyLimitedJobs(sc.team_id, jobIds);
    }

    if (failedToPersist) {
      logger.warn(
        "Crawl queue cancelled after failing to persist crawl state",
        {
          error: saveError,
          jobId: req.params.jobId,
        },
      );
      return res
        .status(500)
        .json({ error: "Failed to persist crawl cancellation" });
    }

    res.json({
      status: "cancelled",
    });
  } catch (error: unknown) {
    logger.error("Failed to cancel crawl", {
      error,
      jobId: req.params.jobId,
    });
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
