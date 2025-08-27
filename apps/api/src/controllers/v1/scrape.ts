import { Response } from "express";
import { logger as _logger } from "../../lib/logger";
import {
  Document,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJob, waitForJob } from "../../services/queue-jobs";
import { getJobPriority } from "../../lib/job-priority";
import { getScrapeQueue } from "../../services/queue-service";
import { fromV1ScrapeOptions } from "../v2/types";
import { TransportableError } from "../../lib/error";

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>,
) {
  const jobId: string = uuidv4();
  const preNormalizedBody = { ...req.body };

  if (req.body.zeroDataRetention && !req.acuc?.flags?.allowZDR) {
    return res.status(400).json({
      success: false,
      error: "Zero data retention is enabled for this team. If you're interested in ZDR, please contact support@firecrawl.com",
    });
  }

  const zeroDataRetention = req.acuc?.flags?.forceZDR || req.body.zeroDataRetention;

  const logger = _logger.child({
    method: "scrapeController",
    jobId,
    scrapeId: jobId,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    zeroDataRetention,
  });
 
  logger.debug("Scrape " + jobId + " starting", {
    scrapeId: jobId,
    request: req.body,
    originalRequest: preNormalizedBody,
    account: req.account,
  });

  req.body = scrapeRequestSchema.parse(req.body);

  const origin = req.body.origin;
  const timeout = req.body.timeout;

  const startTime = new Date().getTime();
  const jobPriority = await getJobPriority({
    team_id: req.auth.team_id,
    basePriority: 10,
  });

  const isDirectToBullMQ = process.env.SEARCH_PREVIEW_TOKEN !== undefined && process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  const { scrapeOptions, internalOptions } = fromV1ScrapeOptions(req.body, req.body.timeout, req.auth.team_id);
  
  const bullJob = await addScrapeJob(
    {
      url: req.body.url,
      mode: "single_urls",
      team_id: req.auth.team_id,
      scrapeOptions,
      internalOptions: {
        ...internalOptions,
        teamId: req.auth.team_id,
        saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME ? true : false,
        unnormalizedSourceURL: preNormalizedBody.url,
        bypassBilling: isDirectToBullMQ,
        zeroDataRetention,
        teamFlags: req.acuc?.flags ?? null,
      },
      origin,
      integration: req.body.integration,
      startTime,
      zeroDataRetention: zeroDataRetention ?? false,
    },
    {},
    jobId,
    jobPriority,
    isDirectToBullMQ,
  );
  logger.info("Added scrape job now" + (bullJob ? "" : " (to concurrency queue)"));

  const totalWait =
    (req.body.waitFor ?? 0) +
    (req.body.actions ?? []).reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 0) : 0) + a,
      0,
    );

  let doc: Document;
  try {
    doc = await waitForJob(bullJob ? bullJob : jobId, timeout + totalWait, logger);
  } catch (e) {
    logger.error(`Error in scrapeController`, {
      startTime,
      error: e,
    });

    if (zeroDataRetention) {
      await getScrapeQueue().remove(jobId);
    }

    if (e instanceof TransportableError) {
      return res.status(e.code === "SCRAPE_TIMEOUT" ? 408 : 500).json({
        success: false,
        code: e.code,
        error: e.message,
      });
    } else {
      return res.status(500).json({
        success: false,
        code: "UNKNOWN_ERROR",
        error: `(Internal server error) - ${e && e.message ? e.message : e}`,
      });
    }
  }

  logger.info("Done with waitForJob");

  await getScrapeQueue().remove(jobId);

  logger.info("Removed job from queue");
  
  if (!req.body.formats.includes("rawHtml")) {
    if (doc && doc.rawHtml) {
      delete doc.rawHtml;
    }
  }

  return res.status(200).json({
    success: true,
    data: doc,
    scrape_id: origin?.includes("website") ? jobId : undefined,
  });
}
