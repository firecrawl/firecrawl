import { Response } from "express";
import { logger } from "../../lib/logger";
import { getCrawl, getCrawlJobs, saveCrawl } from "../../lib/crawl-redis";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { RequestWithAuth } from "./types";
import { crawlGroup } from "../../services/worker/nuq";
import {
  releaseConcurrencyLimitedJob,
  removeConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
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

    // check if the job belongs to the team
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

    // Flip the NuQ group status so subsequent GETs report "cancelled"
    // instead of continuing to read "active" (which the status endpoint
    // surfaces as "scraping").
    try {
      await crawlGroup.setGroupStatus(req.params.jobId, "cancelled");
    } catch (error) {
      logger.error("Failed to set crawl group status to cancelled", {
        crawlId: req.params.jobId,
        error,
      });
    }

    // Release any still-queued child jobs from the team's concurrency
    // queue so the queue cap (concurrency-limit-queue:{team_id}) is
    // freed immediately rather than waiting for MAX_BACKLOG_TIMEOUT_MS
    // (48h). Active jobs are also dropped from concurrency-limiter so
    // workers checking sc.cancelled can short-circuit cleanly.
    try {
      const childJobIds = await getCrawlJobs(req.params.jobId);
      await Promise.all(
        childJobIds.flatMap(childId => [
          releaseConcurrencyLimitedJob(sc.team_id, childId),
          removeConcurrencyLimitActiveJob(sc.team_id, childId),
        ]),
      );
    } catch (error) {
      logger.error("Failed to release concurrency queue slots on cancel", {
        crawlId: req.params.jobId,
        error,
      });
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
