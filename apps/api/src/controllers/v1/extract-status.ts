import { Response } from "express";
import { config } from "../../config";
import { RequestWithAuth } from "./types";
import {
  getExtract,
  getExtractExpiry,
  getExtractResult,
} from "../../lib/extract/extract-redis";
import { supabaseGetExtractByIdDirect } from "../../lib/supabase-jobs";
import { logger as _logger } from "../../lib/logger";
import { getJobFromGCS } from "../../lib/gcs-jobs";

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

  // Get extract status from Redis (for in-progress jobs)
  const extract = await getExtract(req.params.jobId);

  // Check team ownership from Redis
  if (extract && extract.team_id !== req.auth.team_id) {
    return res.status(404).json({
      success: false,
      error: "Extract job not found",
    });
  }

  // If not in Redis, check the database for completed jobs
  if (!extract) {
    if (config.USE_DB_AUTHENTICATION) {
      const dbExtract = await supabaseGetExtractByIdDirect(req.params.jobId);
      if (!dbExtract) {
        logger.warn("Extract job was not found");
        return res.status(404).json({
          success: false,
          error: "Extract job not found",
        });
      }

      if (dbExtract.team_id !== req.auth.team_id) {
        return res.status(404).json({
          success: false,
          error: "Extract job not found",
        });
      }

      let data: any = [];
      if (dbExtract.is_successful) {
        data = await getExtractData(req.params.jobId);
      }

      // Return DB-based status
      return res.status(200).json({
        success: dbExtract.is_successful,
        data,
        status: dbExtract.is_successful ? "completed" : "failed",
        error: dbExtract.error || undefined,
        expiresAt: new Date(
          new Date(dbExtract.created_at).getTime() + 1000 * 60 * 60 * 24,
        ).toISOString(),
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
