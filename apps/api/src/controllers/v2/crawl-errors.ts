import { Response } from "express";
import { config } from "../../config";
import {
  CrawlErrorsResponse,
  CrawlStatusParams,
  RequestWithAuth,
} from "./types";
import { getCrawl, getCrawlJobs } from "../../lib/crawl-redis";
import { redisEvictConnection } from "../../../src/services/redis";
import { configDotenv } from "dotenv";
import { supabase_rr_service } from "../../services/supabase";
import { logger as _logger } from "../../lib/logger";
import { deserializeTransportableError } from "../../lib/error-serde";
import { TransportableError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
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

    const logger = _logger.child({
      crawlId: req.params.jobId,
      zeroDataRetention: sc.zeroDataRetention ?? false,
    });

    const failedJobs = (
      await scrapeQueue.getJobsWithStatus(
        await getCrawlJobs(req.params.jobId),
        "failed",
        logger,
      )
    ).filter(x => x.failedReason);

    res.status(200).json({
      errors: failedJobs
        .map(x => {
          if (x.data.mode !== "single_urls") {
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
  } else if (config.USE_DB_AUTHENTICATION) {
    // Check the requests table for the crawl/batch scrape request
    const { data: request, error: requestError } = await supabase_rr_service
      .from("requests")
      .select("*")
      .eq("id", req.params.jobId)
      .limit(1)
      .throwOnError();

    if (requestError) {
      _logger.error("Error getting request", { error: requestError });
      throw requestError;
    }

    const requestData = request?.[0];

    if (requestData && requestData.team_id !== req.auth.team_id) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const crawlTtlHours = req.acuc?.flags?.crawlTtlHours ?? 24;
    const crawlTtlMs = crawlTtlHours * 60 * 60 * 1000;

    if (
      requestData &&
      new Date().valueOf() - new Date(requestData.created_at).valueOf() >
        crawlTtlMs
    ) {
      return res.status(404).json({ success: false, error: "Job expired" });
    }

    if (!request || request.length === 0) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    // Get failed scrapes from the scrapes table
    const { data: failedScrapes, error: failedScrapesError } =
      await supabase_rr_service
        .from("scrapes")
        .select("*")
        .eq("request_id", req.params.jobId)
        .eq("team_id", req.auth.team_id)
        .eq("success", false)
        .throwOnError();

    if (failedScrapesError) {
      _logger.error("Error getting failed scrapes", {
        error: failedScrapesError,
      });
      throw failedScrapesError;
    }

    res.status(200).json({
      errors: (failedScrapes || []).map(scrape => {
        const error = deserializeTransportableError(
          scrape.error,
        ) as TransportableError | null;
        return {
          id: scrape.id,
          timestamp:
            scrape.created_at !== undefined
              ? new Date(scrape.created_at).toISOString()
              : undefined,
          url: scrape.url,
          ...(error
            ? {
                code: error.code,
                error: error.message,
              }
            : {
                error: scrape.error,
              }),
        };
      }),
      robotsBlocked: await redisEvictConnection.smembers(
        "crawl:" + req.params.jobId + ":robots_blocked",
      ),
    });
  } else {
    return res.status(404).json({ success: false, error: "Job not found" });
  }
}
