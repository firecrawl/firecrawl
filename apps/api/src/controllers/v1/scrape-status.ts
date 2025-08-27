import { Response } from "express";
import { supabaseGetJobByIdOnlyData } from "../../lib/supabase-jobs";
import { getJob } from "./crawl-status";
import { logger as _logger } from "../../lib/logger";

export async function scrapeStatusController(req: any, res: any) {
  const logger = _logger.child({
    module: "scrape-status",
    method: "scrapeStatusController",
    teamId: req.auth.team_id,
    jobId: req.params.jobId,
    scrapeId: req.params.jobId,
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({ success: false, error: "Your team has zero data retention enabled. This is not supported on scrape status. Please contact support@firecrawl.com to unblock this feature." });
  }

  const job = await supabaseGetJobByIdOnlyData(req.params.jobId, logger);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found.",
    });
  }

  if (
    job?.team_id !== req.auth.team_id
  ) {
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
