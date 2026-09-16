import { Response } from "express";
import { config } from "../../config";
import {
  CrawlErrorsResponse,
  CrawlStatusParams,
  RequestWithAuth,
} from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { redisEvictConnection } from "../../../src/services/redis";
import { configDotenv } from "dotenv";
import { getCrawlJobAccess } from "../../lib/operational-job-access";
import { logger as _logger } from "../../lib/logger";
import { deserializeTransportableError } from "../../lib/error-serde";
import { TransportableError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq-router";
configDotenv();

export async function crawlErrorsController(
  req: RequestWithAuth<CrawlStatusParams, undefined, CrawlErrorsResponse>,
  res: Response<CrawlErrorsResponse>,
) {
  const sc = await getCrawl(req.params.jobId);

  if (sc) {
    if (sc.team_id !== req.auth.team_id) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
  } else if (config.USE_DB_AUTHENTICATION) {
    const crawlTtlHours = req.acuc?.flags?.crawlTtlHours ?? 24;
    let access;
    try {
      access = await getCrawlJobAccess(req.params.jobId, crawlTtlHours);
    } catch (requestError) {
      _logger.error("Error getting request", { error: requestError });
      throw requestError;
    }

    if (access && access.teamId !== req.auth.team_id) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    if (access && access.expiresAtMs <= Date.now()) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }

    if (!access) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
  } else {
    return res.status(404).json({ success: false, error: "Job not found" });
  }

  const logger = _logger.child({
    crawlId: req.params.jobId,
    zeroDataRetention: sc?.zeroDataRetention ?? false,
  });
  const failedJobs = (
    await scrapeQueue.getGroupJobs(
      req.params.jobId,
      "failed",
      undefined,
      0,
      logger,
    )
  ).filter(x => x.failedReason);

  return res.status(200).json({
    errors: failedJobs
      .map(x => {
        if (x.data?.mode !== "single_urls") {
          return null;
        }
        const error = deserializeTransportableError(
          x.failedReason!,
        ) as TransportableError | null;
        if (error?.code === "SCRAPE_RACED_REDIRECT_ERROR") {
          return null;
        }
        return {
          id: x.id,
          timestamp:
            x.finishedAt !== undefined
              ? new Date(x.finishedAt).toISOString()
              : undefined,
          url: x.data.url,
          ...(error
            ? {
                code: error.code,
                error: error.message,
              }
            : {
                error: x.failedReason!,
              }),
        };
      })
      .filter(x => x !== null),
    robotsBlocked: await redisEvictConnection.smembers(
      "crawl:" + req.params.jobId + ":robots_blocked",
    ),
  });
}
