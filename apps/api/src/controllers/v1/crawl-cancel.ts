import { Response } from "express";
import { logger } from "../../lib/logger";
import { getCrawl } from "../../lib/crawl-redis";
import { configDotenv } from "dotenv";
import { RequestWithAuth } from "./types";
import { crawlGroup } from "../../services/worker/nuq-router";
import { cancelCrawl } from "../../lib/crawl-cancel";
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

    await cancelCrawl(req.params.jobId, sc);

    res.json({
      status: "cancelled",
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
