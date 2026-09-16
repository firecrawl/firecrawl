import { Response } from "express";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import {
  getExtract,
  getExtractExpiry,
  getExtractResult,
} from "../../lib/extract/extract-redis";
import {
  supabaseGetAgentByIdDirect,
  supabaseGetExtractByIdDirect,
} from "../../lib/supabase-jobs";
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
  const access = config.USE_DB_AUTHENTICATION
    ? await getExtractJobAccess(req.params.jobId)
    : null;
  if (config.USE_DB_AUTHENTICATION) {
    if (
      !access ||
      access.expiresAtMs <= Date.now() ||
      access.teamId !== normalizeJobAccessTeamId(req.auth.team_id)
    ) {
      return res.status(404).json({
        success: false,
        error: "Extract job not found",
      });
    }

    if (access.kind === "agent") {
      const agent = await supabaseGetAgentByIdDirect(req.params.jobId);

      let data: any = undefined;
      if (agent?.is_successful) {
        data = await getJobFromGCS(agent.id);
      }

      return res.status(200).json({
        success: true,
        status: !agent
          ? "processing"
          : agent.is_successful
            ? "completed"
            : "failed",
        error: agent?.error || undefined,
        data,
        expiresAt: new Date(access.expiresAtMs).toISOString(),
        creditsUsed: agent?.credits_cost,
      });
    }
  }

  // Get extract status from Redis (for in-progress jobs)
  const redisExtract = await getExtract(req.params.jobId);

  // If not in Redis, check the database for completed jobs
  if (!redisExtract) {
    if (config.USE_DB_AUTHENTICATION) {
      const state = await readExtractJobState(req.params.jobId).catch(error => {
        _logger.warn(
          "Bigtable extract state read failed; using legacy lookup",
          { error, extractId: req.params.jobId },
        );
        return null;
      });
      if (state) {
        return res.status(200).json({
          success: state.status === "completed",
          data:
            state.status === "completed"
              ? await getExtractData(req.params.jobId)
              : [],
          status: state.status,
          error: state.error,
          expiresAt: new Date(access!.expiresAtMs).toISOString(),
          creditsUsed: state.creditsBilled,
        });
      }

      const dbExtract = await supabaseGetExtractByIdDirect(req.params.jobId);
      if (dbExtract) {
        // Get result data
        let data: any = [];
        if (dbExtract.is_successful) {
          data = await getExtractData(req.params.jobId);
        }

        return res.status(200).json({
          success: dbExtract.is_successful,
          data,
          status: dbExtract.is_successful ? "completed" : "failed",
          error: dbExtract.error || undefined,
          expiresAt: new Date(access!.expiresAtMs).toISOString(),
        });
      }
    }

    // Fall back to extractRequest info
    return res.status(200).json({
      success: true,
      data: [],
      status: "processing",
      expiresAt: new Date(access!.expiresAtMs).toISOString(),
    });
  }

  // Get result data if completed
  let data: any = [];
  if (redisExtract.status === "completed") {
    data = await getExtractData(req.params.jobId);
  }

  return res.status(200).json({
    success: redisExtract.status === "failed" ? false : true,
    data,
    status: redisExtract.status,
    error: (() => {
      if (typeof redisExtract.error === "string") return redisExtract.error;
      if (redisExtract.error && typeof redisExtract.error === "object") {
        return typeof redisExtract.error.message === "string"
          ? redisExtract.error.message
          : typeof redisExtract.error.error === "string"
            ? redisExtract.error.error
            : JSON.stringify(redisExtract.error);
      }
      return undefined;
    })(),
    expiresAt: (await getExtractExpiry(req.params.jobId)).toISOString(),
    steps: redisExtract.showSteps ? redisExtract.steps : undefined,
    llmUsage: redisExtract.showLLMUsage ? redisExtract.llmUsage : undefined,
    sources: redisExtract.showSources ? redisExtract.sources : undefined,
    costTracking: redisExtract.showCostTracking
      ? redisExtract.costTracking
      : undefined,
    sessionIds: redisExtract.sessionIds ? redisExtract.sessionIds : undefined,
    tokensUsed: redisExtract.tokensBilled
      ? redisExtract.tokensBilled
      : undefined,
    creditsUsed: redisExtract.creditsBilled
      ? redisExtract.creditsBilled
      : undefined,
  });
}
