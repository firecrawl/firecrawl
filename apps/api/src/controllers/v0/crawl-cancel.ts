import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { logger } from "../../../src/lib/logger";
import { getCrawl, saveCrawl } from "../../../src/lib/crawl-redis";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { redisEvictConnection } from "../../../src/services/redis";
configDotenv();

export async function crawlCancelController(req: Request, res: Response) {
  try {
    const auth = await authenticateUser(req, res, RateLimiterMode.CrawlStatus);
    if (!auth.success) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const { team_id } = auth;

    if (auth.chunk?.flags?.forceZDR) {
      return res.status(400).json({ error: "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API." });
    }

    redisEvictConnection.sadd("teams_using_v0", team_id)
      .catch(error => logger.error("Failed to add team to teams_using_v0", { error, team_id }));
    
    redisEvictConnection.sadd("teams_using_v0:" + team_id, "crawl:" + req.params.jobId + ":cancel")
      .catch(error => logger.error("Failed to add team to teams_using_v0 (2)", { error, team_id }));

    const sc = await getCrawl(req.params.jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    // check if the job belongs to the team
    if (sc.team_id !== team_id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      sc.cancelled = true;
      await saveCrawl(req.params.jobId, sc);
    } catch (error) {
      logger.error(error);
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
