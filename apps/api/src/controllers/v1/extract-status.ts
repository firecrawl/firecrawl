import { Response } from "express";
import { RequestWithAuth } from "./types";
import { getExtract, getExtractExpiry } from "../../lib/extract/extract-redis";
import { DBJob, PseudoJob } from "./crawl-status";
import { getExtractQueue } from "../../services/queue-service";
import { ExtractResult } from "../../lib/extract/extraction-service";
import { supabaseGetJobByIdDirect } from "../../lib/supabase-jobs";

export async function getExtractJob(id: string): Promise<PseudoJob<ExtractResult> | null> {
  const [bullJob, dbJob] = await Promise.all([
    getExtractQueue().getJob(id),
    (process.env.USE_DB_AUTHENTICATION === "true" ? supabaseGetJobByIdDirect(id) : null) as Promise<DBJob | null>,
  ]);

  if (!bullJob && !dbJob) return null;

  const data = dbJob?.docs ?? bullJob?.returnvalue?.data;

  const job: PseudoJob<any> = {
    id,
    getState: dbJob ? (() => dbJob.success ? "completed" : "failed") : (() => bullJob!.getState()),
    returnvalue: data,
    data: {
      scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbJob!.page_options,
      teamId: bullJob ? bullJob.data.teamId : dbJob!.team_id,
    },
    timestamp: bullJob ? bullJob.timestamp : new Date(dbJob!.date_added).valueOf(),
    failedReason: (bullJob ? bullJob.failedReason : dbJob!.message) || undefined,
  }

  return job;
}

export async function extractStatusController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  const extract = await getExtract(req.params.jobId);

  let status = extract?.status;

  if (extract && extract.team_id !== req.auth.team_id) {
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  let data: ExtractResult | [] = [];

  if (!extract || extract.status === "completed") {
    const jobData = await getExtractJob(req.params.jobId);
    if ((!jobData && !extract) || (jobData && jobData.data.teamId !== req.auth.team_id)) {
      return res.status(404).json({
        success: false,
        error: "Extract job not found",
      });
    }

    if (jobData) {
      const jobStatus = await jobData.getState();

      if (jobStatus === "completed") {
        status = "completed";
      } else if (jobStatus === "failed") {
        status = "failed";
      } else {
        status = "processing";
      }
    }

    if (!jobData?.returnvalue) {
      // if we got in the split-second where the redis is updated but the bull isn't
      // just pretend it's still processing - MG
      status = "processing";
    } else {
      data = jobData.returnvalue ?? [];
    }
  }

  return res.status(200).json({
    success: status === "failed" ? false : true,
    data,
    status,
    error: extract?.error ?? undefined,
    expiresAt: (await getExtractExpiry(req.params.jobId)).toISOString(),
    steps: extract?.showSteps ? extract.steps : undefined,
    llmUsage: extract?.showLLMUsage ? extract.llmUsage : undefined,
    sources: extract?.showSources ? extract.sources : undefined,
    costTracking: extract?.showCostTracking ? extract.costTracking : undefined,
    sessionIds: extract?.sessionIds ? extract.sessionIds : undefined,
    tokensUsed: extract?.tokensBilled ? extract.tokensBilled : undefined,
  });
}
