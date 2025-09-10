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
import { hasFormatOfType } from "../../lib/format-utils";
import { TransportableError } from "../../lib/error";
import { scrapeQueue } from "../../services/worker/nuq";
import { checkPermissions } from "../../lib/permissions";

export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>,
) {
  const jobId = uuidv4();
  const preNormalizedBody = { ...req.body };
  req.body = scrapeRequestSchema.parse(req.body);

  const permissions = checkPermissions(req.body, req.acuc?.flags);
  if (permissions.error) {
    return res.status(403).json({
      success: false,
      error: permissions.error,
      id: jobId,
    });
  }

  const zeroDataRetention =
    req.acuc?.flags?.forceZDR || req.body.zeroDataRetention;

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

  const origin = req.body.origin;
  const timeout = req.body.timeout;

  const startTime = new Date().getTime();

  const isDirectToBullMQ =
    process.env.SEARCH_PREVIEW_TOKEN !== undefined &&
    process.env.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  const jobPriority = await getJobPriority({
    team_id: req.auth.team_id,
    basePriority: 10,
  });

  const job = await addScrapeJob(
    {
      url: req.body.url,
      mode: "single_urls",
      team_id: req.auth.team_id,
      scrapeOptions: {
        ...req.body,
        ...(req.body.__experimental_cache
          ? {
              maxAge: req.body.maxAge ?? 4 * 60 * 60 * 1000, // 4 hours
            }
          : {}),
      },
      internalOptions: {
        teamId: req.auth.team_id,
        saveScrapeResultToGCS: process.env.GCS_FIRE_ENGINE_BUCKET_NAME
          ? true
          : false,
        unnormalizedSourceURL: preNormalizedBody.url,
        bypassBilling: isDirectToBullMQ,
        zeroDataRetention,
        teamFlags: req.acuc?.flags ?? null,
      },
      origin,
      integration: req.body.integration,
      startTime,
      zeroDataRetention,
      apiKeyId: req.acuc?.api_key_id ?? null,
    },
    jobId,
    jobPriority,
    isDirectToBullMQ,
  );

  const totalWait =
    (req.body.waitFor ?? 0) +
    (req.body.actions ?? []).reduce(
      (a, x) => (x.type === "wait" ? (x.milliseconds ?? 0) : 0) + a,
      0,
    );

  let doc: Document;
  try {
    doc = await waitForJob(
      job ?? jobId,
      timeout !== undefined ? timeout + totalWait : null,
      zeroDataRetention,
      logger,
    );
  } catch (e) {
    logger.error(`Error in scrapeController`, {
      startTime,
      error: e,
    });

    if (zeroDataRetention) {
      await scrapeQueue.removeJob(jobId);
    }

    if (e instanceof TransportableError) {
      return res.status(e.code === "SCRAPE_TIMEOUT" ? 408 : 500).json({
        success: false,
        code: e.code,
        error: e.message,
        id: jobId,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `(Internal server error) - ${e && e.message ? e.message : e}`,
        id: jobId,
      });
    }
  }

  await scrapeQueue.removeJob(jobId);

  if (!hasFormatOfType(req.body.formats, "rawHtml")) {
    if (doc && doc.rawHtml) {
      delete doc.rawHtml;
    }
  }

  return res.status(200).json({
    success: true,
    data: doc,
    id: origin?.includes("website") ? jobId : undefined,
    scrape_id: origin?.includes("website") ? jobId : undefined,
  });
}
