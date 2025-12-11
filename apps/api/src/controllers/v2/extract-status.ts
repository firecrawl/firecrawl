import { Response } from "express";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import { getExtract, getExtractExpiry } from "../../lib/extract/extract-redis";
import { getExtractQueue } from "../../services/queue-service";
import { ExtractResult } from "../../lib/extract/extraction-service";
import { supabaseGetExtractByIdDirect } from "../../lib/supabase-jobs";
import { JobState } from "bullmq";
import { logger as _logger } from "../../lib/logger";

type DBExtract = {
  id: string;
  success: boolean;
  options: any;
  created_at: any;
  error: string | null;
  team_id: string;
};

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
  const [bullJob, dbExtract] = await Promise.all([
    getExtractQueue().getJob(id),
    (config.USE_DB_AUTHENTICATION
      ? supabaseGetExtractByIdDirect(id)
      : null) as Promise<DBExtract | null>,
  ]);

  if (!bullJob && !dbExtract) return null;

  // Extract results are stored in GCS, not in the DB
  const data = bullJob?.returnvalue?.data;

  const job: ExtractPseudoJob<any> = {
    id,
    getState: bullJob
      ? bullJob.getState.bind(bullJob)
      : () => (dbExtract!.success ? "completed" : "failed"),
    returnvalue: data,
    data: {
      scrapeOptions: bullJob ? bullJob.data.scrapeOptions : dbExtract!.options,
      teamId: bullJob ? bullJob.data.teamId : dbExtract!.team_id,
    },
    timestamp: bullJob
      ? bullJob.timestamp
      : new Date(dbExtract!.created_at).valueOf(),
    failedReason:
      (bullJob ? bullJob.failedReason : dbExtract!.error) || undefined,
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
        return (
          extract.error.message ||
          extract.error.error ||
          JSON.stringify(extract.error)
        );
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
    creditsUsed: extract?.creditsBilled ? extract.creditsBilled : undefined,
  });
}
