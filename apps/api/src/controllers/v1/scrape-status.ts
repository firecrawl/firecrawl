import { Response } from "express";
import { getJob } from "./crawl-status";
import { logger as _logger } from "../../lib/logger";
import { getScrapeZDR } from "../../lib/zdr-helpers";
import { getScrapeJobAccess } from "../../lib/operational-job-access";

export async function scrapeStatusController(req: any, res: any) {
  const logger = _logger.child({
    module: "scrape-status",
    method: "scrapeStatusController",
    teamId: req.auth.team_id,
    jobId: req.params.jobId,
    scrapeId: req.params.jobId,
    zeroDataRetention: getScrapeZDR(req.acuc?.flags) === "forced",
  });

  if (getScrapeZDR(req.acuc?.flags) === "forced") {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on scrape status. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const access = await getScrapeJobAccess(req.params.jobId);

  if (!access || access.expiresAtMs <= Date.now()) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  if (access.teamId !== req.auth.team_id) {
    return res.status(403).json({
      success: false,
      error: "You are not allowed to access this resource.",
    });
  }

  const jobData = await getJob(req.params.jobId);
  const data = Array.isArray(jobData?.returnvalue)
    ? jobData?.returnvalue[0]
    : jobData?.returnvalue;

  if (!data) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  return res.status(200).json({
    success: true,
    data,
  });
}
