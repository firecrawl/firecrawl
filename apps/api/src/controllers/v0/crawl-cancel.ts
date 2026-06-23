import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { logger } from "../../../src/lib/logger";
import { getCrawl, saveCrawl } from "../../../src/lib/crawl-redis";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { redisEvictConnection } from "../../../src/services/redis";
import { crawlGroup } from "../../services/worker/nuq-router";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { applyAgentAuthDiscoveryHeader } from "../../lib/agent-auth-discovery";
configDotenv();

export async function crawlCancelController(req: Request, res: Response) {
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

    const { team_id } = auth;

    if (getScrapeZDR(auth.chunk?.flags) === "forced") {
      return res.status(400).json({
        error:
          "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API.",
      });
    }

    redisEvictConnection.sadd("teams_using_v0", team_id).catch(error =>
      logger.error("Failed to add team to teams_using_v0", {
        error,
        team_id,
      }),
    );

    redisEvictConnection
      .sadd("teams_using_v0:" + team_id, "crawl:" + jobId + ":cancel")
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

    // check if the job belongs to the team
    if (sc.team_id !== team_id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const group = await crawlGroup.getGroup(jobId);
    if (!group) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (group.status === "completed") {
      return res.status(409).json({ error: "Crawl is already completed" });
    }

    try {
      sc.cancelled = true;
      await saveCrawl(jobId, sc);
    } catch (error) {
      logger.error(error);
    }

    if (sc.queueBackend === "fdb") {
      await crawlGroup.cancelGroup(jobId);
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
