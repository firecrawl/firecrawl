import { Response } from "express";
import {
  CrawlErrorsResponse,
  CrawlStatusParams,
  RequestWithAuth,
} from "./types";
import { getCrawl } from "../../lib/crawl-redis";
import { redisEvictConnection } from "../../../src/services/redis";
import { configDotenv } from "dotenv";
import { storedZeroDataRetention } from "../../lib/request-context";
import { logger as _logger } from "../../lib/logger";
import { deserializeTransportableError } from "../../lib/error-serde";
import { TransportableError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq-router";
import { service } from "../../service";
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
  } else {
    const jobKind = (req.path || req.originalUrl || "").includes(
      "/batch/scrape/",
    )
      ? "batchScrape"
      : "crawl";
    let owner;
    try {
      owner = await service.modules.jobStore.owner(req.params.jobId, jobKind);
    } catch (requestError) {
      _logger.error("Error getting request", { error: requestError });
      throw requestError;
    }

    if (
      owner &&
      !(owner.matchesTeam
        ? owner.matchesTeam(req.auth.team_id)
        : owner.teamId === req.auth.team_id)
    ) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    if (
      owner &&
      owner.expiresAtMs !== undefined &&
      owner.expiresAtMs <= Date.now()
    ) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }

    if (!owner) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
  }

  const logger = _logger.child({
    crawlId: req.params.jobId,
    zeroDataRetention: storedZeroDataRetention(sc) ?? false,
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
          url:
            x.data && "url" in x.data
              ? x.data.url
              : "<redacted due to zero data retention>",
          ...(error
            ? {
                code: error.code,
                error: error.message,
                ...("requiresAction" in error &&
                (
                  error as {
                    requiresAction?: Extract<
                      CrawlErrorsResponse,
                      { errors: unknown }
                    >["errors"][number]["requiresAction"];
                  }
                ).requiresAction !== undefined
                  ? {
                      requiresAction: (
                        error as {
                          requiresAction?: Extract<
                            CrawlErrorsResponse,
                            { errors: unknown }
                          >["errors"][number]["requiresAction"];
                        }
                      ).requiresAction,
                    }
                  : {}),
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
