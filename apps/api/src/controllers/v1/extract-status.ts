import { Response } from "express";
import { JOB_ACCESS_TTL_MS } from "../../lib/job-access-store";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import {
  getExtract,
  getExtractExpiry,
  getExtractResult,
} from "../../lib/extract/extract-redis";
import { logger as _logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { getExtractJobAccess } from "../../lib/operational-job-access";
import { readExtractJobState } from "../../lib/job-state-store";
import { normalizeJobAccessTeamId } from "../../lib/job-access-store";

async function getExtractData(id: string): Promise<any> {
  // Try GCS first if configured
  if (config.GCS_BUCKET_NAME) {
    const gcsData = await getJobFromGCS(id);
    if (gcsData) {
      return Array.isArray(gcsData) ? gcsData[0] : gcsData;
    }
  }
  // Fallback to Redis
  const redisData = await getExtractResult(id);
  if (redisData) {
    return Array.isArray(redisData) ? redisData[0] : redisData;
  }
  return [];
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

  const access = config.USE_DB_AUTHENTICATION
    ? await getExtractJobAccess(req.params.jobId)
    : null;
  if (
    config.USE_DB_AUTHENTICATION &&
    (!access ||
      access.expiresAtMs <= Date.now() ||
      access.teamId !== normalizeJobAccessTeamId(req.auth.team_id))
  ) {
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  // Get extract status from Redis (for in-progress jobs)
  const extract = await getExtract(req.params.jobId);

  // Check team ownership from Redis
  if (extract && extract.team_id !== req.auth.team_id) {
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  // Not in Redis: the job finished (or never existed). Bigtable holds the
  // terminal state for 24 hours; after that the job has expired.
  if (!extract) {
    // A failed Bigtable read is an outage, not a missing job: it propagates
    // to the error handler rather than answering 404.
    const state = await readExtractJobState(req.params.jobId);
    if (state) {
      return res.status(200).json({
        success: state.status === "completed",
        data:
          state.status === "completed"
            ? await getExtractData(req.params.jobId)
            : [],
        status: state.status,
        error: state.error,
        expiresAt: new Date(
          access?.expiresAtMs ?? state.completedAtMs + JOB_ACCESS_TTL_MS,
        ).toISOString(),
        creditsUsed: state.creditsBilled,
      });
    }

    logger.warn("Extract job was not found");
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  // Get result data if completed
  let data: any = [];
  if (extract.status === "completed") {
    data = await getExtractData(req.params.jobId);
  }

  // Return Redis-based status
  return res.status(200).json({
    success: extract.status === "failed" ? false : true,
    data,
    status: extract.status,
    error: (() => {
      if (typeof extract.error === "string") return extract.error;
      if (extract.error && typeof extract.error === "object") {
        return typeof extract.error.message === "string"
          ? extract.error.message
          : typeof extract.error.error === "string"
            ? extract.error.error
            : JSON.stringify(extract.error);
      }
      return undefined;
    })(),
    expiresAt: (await getExtractExpiry(req.params.jobId)).toISOString(),
    steps: extract.showSteps ? extract.steps : undefined,
    llmUsage: extract.showLLMUsage ? extract.llmUsage : undefined,
    sources: extract.showSources ? extract.sources : undefined,
    costTracking: extract.showCostTracking ? extract.costTracking : undefined,
    sessionIds: extract.sessionIds ? extract.sessionIds : undefined,
    tokensUsed: extract.tokensBilled ? extract.tokensBilled : undefined,
    creditsUsed: extract.creditsBilled ? extract.creditsBilled : undefined,
  });
}
