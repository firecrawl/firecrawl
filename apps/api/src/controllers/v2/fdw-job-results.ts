import { Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { fetchFdwJobOwnership } from "../../lib/fdw/jobs";
import { getJobFromGCS } from "../../lib/gcs-jobs";
import { getExtractResult } from "../../lib/extract/extract-redis";
import { isClickhouseConfigured } from "../../services/clickhouse";
import { ErrorResponse, RequestWithAuth } from "./types";

const fdwJobResultsSchema = z.object({
  job_ids: z.array(z.string().uuid()).min(1).max(100),
});

type FdwJobResultRow = {
  job_id: string;
  mode: string | null;
  result_json: unknown | null;
  found: boolean;
  error: string | null;
};

const getJobResultPayload = async (
  mode: string,
  jobId: string,
): Promise<unknown | null> => {
  const gcsData = await getJobFromGCS(jobId);
  if (gcsData) {
    return gcsData;
  }

  if (mode === "extract") {
    const redisData = await getExtractResult(jobId);
    if (redisData) {
      return redisData;
    }
  }

  return null;
};

export async function fdwJobResultsController(
  req: RequestWithAuth<{}, any, { job_ids: string[] }>,
  res: Response<{ success: true; data: FdwJobResultRow[] } | ErrorResponse>,
) {
  if (!config.FIRECRAWL_FDW_ENABLED) {
    return res.status(404).json({
      success: false,
      error: "Not found",
    });
  }

  if (!isClickhouseConfigured()) {
    return res.status(503).json({
      success: false,
      error: "ClickHouse is not configured",
    });
  }

  const apiKeyId = req.acuc?.api_key_id;
  if (!apiKeyId) {
    return res.status(400).json({
      success: false,
      error: "API key scope not available",
    });
  }

  const parsed = fdwJobResultsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: "Invalid job_ids",
    });
  }

  const jobIds = Array.from(new Set(parsed.data.job_ids));

  const ownershipRows = await fetchFdwJobOwnership(apiKeyId, jobIds);
  const ownershipMap = new Map(
    ownershipRows.map(row => [row.job_id, row.mode]),
  );

  const results = await Promise.all(
    jobIds.map(async jobId => {
      const mode = ownershipMap.get(jobId) ?? null;
      if (!mode) {
        return {
          job_id: jobId,
          mode: null,
          result_json: null,
          found: false,
          error: "unauthorized_or_not_found",
        } satisfies FdwJobResultRow;
      }

      const payload = await getJobResultPayload(mode, jobId);
      if (payload === null) {
        return {
          job_id: jobId,
          mode,
          result_json: null,
          found: false,
          error: "result_not_found",
        } satisfies FdwJobResultRow;
      }

      return {
        job_id: jobId,
        mode,
        result_json: payload,
        found: true,
        error: null,
      } satisfies FdwJobResultRow;
    }),
  );

  return res.json({
    success: true,
    data: results,
  });
}
