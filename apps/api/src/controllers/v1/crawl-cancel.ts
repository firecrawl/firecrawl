import { Response } from "express";
import { logger } from "../../lib/logger";
import { getCrawl, getCrawlJobs, saveCrawl } from "../../lib/crawl-redis";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { RequestWithAuth } from "./types";
import { crawlGroup } from "../../services/worker/nuq-router";
import { removeConcurrencyLimitedJobs } from "../../lib/concurrency-limit";
configDotenv();

export async function crawlCancelController(
  req: RequestWithAuth<{ jobId: string }>,
  res: Response,
) {
  try {
    const sc = await getCrawl(req.params.jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (sc.team_id !== req.auth.team_id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const group = await crawlGroup.getGroup(req.params.jobId);
    if (!group) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (group.status === "completed") {
      return res.status(409).json({ error: "Crawl is already completed" });
    }

    try {
      sc.cancelled = true;
      await saveCrawl(req.params.jobId, sc);
    } catch (error) {
      logger.error(error);
    }

    if (sc.queueBackend === "fdb") {
      await crawlGroup.cancelGroup(req.params.jobId);
    } else {
      const jobIds = await getCrawlJobs(req.params.jobId);
      await removeConcurrencyLimitedJobs(sc.team_id, jobIds);
    }

    res.json({
      status: "cancelled",
    });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
