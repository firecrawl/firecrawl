import { Response } from "express";
import { RequestWithAuth } from "./types";
import { getExtract, getExtractExpiry } from "../../lib/extract/extract-redis";
import { DBJob } from "./crawl-status";
import { getExtractQueue } from "../../services/queue-service";
import { ExtractResult } from "../../lib/extract/extraction-service";
import { supabaseGetJobByIdDirect } from "../../lib/supabase-jobs";
import { JobState } from "bullmq";
import { logger as _logger } from "../../lib/logger";

type ExtractPseudoJob<T> = {
  id: string;
  getState: () => Promise<JobState | "unknown"> | JobState | "unknown";
  returnvalue: T | null;
  timestamp: number;
  data: {
    scrapeOptions: any;
    teamId?: string;
  };
  failedReason?: string;
};

async function getExtractJob(
  id: string,
): Promise<ExtractPseudoJob<ExtractResult> | null> {
  const [bullJob, dbJob] = await Promise.all([
    getExtractQueue().getJob(id),
    (process.env.USE_DB_AUTHENTICATION === "true"
      ? supabaseGetJobByIdDirect(id)
      : null) as Promise<DBJob | null>,
  ]);

  if (!bullJob && !dbJob) return null;

  const data = dbJob?.docs ?? bullJob?.returnvalue?.data;

  const job: ExtractPseudoJob<any> = {
    id,
    getState: bullJob
      ? bullJob.getState.bind(bullJob)
      : () => (dbJob!.success ? "completed" : "failed"),
    returnvalue: data,
    data: {
      scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbJob!.page_options,
      teamId: bullJob ? bullJob.data.teamId : dbJob!.team_id,
    },
    timestamp: bullJob
      ? bullJob.timestamp
      : new Date(dbJob!.date_added).valueOf(),
    failedReason:
      (bullJob ? bullJob.failedReason : dbJob!.message) || undefined,
  };

  return job;
}

export async function extractStatusController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  const logger = _logger.child({
    module: "v1/extract-status",
    method: "extractStatusController",
    teamId: req.auth.team_id,
    extractId: req.params.jobId,
  });

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
    if (
      (!jobData && !extract) ||
      (jobData && jobData.data.teamId !== req.auth.team_id)
    ) {
      logger.warn("Extract job was not found");
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
    error: (() => {
      if (typeof extract?.error === "string") return extract.error;
      if (extract?.error && typeof extract.error === "object") {
        return extract.error.message || extract.error.error || JSON.stringify(extract.error);
      }
      return undefined;
    })(),
    expiresAt: (await getExtractExpiry(req.params.jobId)).toISOString(),
    steps: extract?.showSteps ? extract.steps : undefined,
    llmUsage: extract?.showLLMUsage ? extract.llmUsage : undefined,
    sources: extract?.showSources ? extract.sources : undefined,
    costTracking: extract?.showCostTracking ? extract.costTracking : undefined,
    sessionIds: extract?.sessionIds ? extract.sessionIds : undefined,
    tokensUsed: extract?.tokensBilled ? extract.tokensBilled : undefined,
  });
}
