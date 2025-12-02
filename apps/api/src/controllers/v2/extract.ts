import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import {
  RequestWithAuth,
  ExtractRequest,
  extractRequestSchema,
  ExtractResponse,
} from "./types";
import { getExtractQueue } from "../../services/queue-service";
import { saveExtract } from "../../lib/extract/extract-redis";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { logger as _logger } from "../../lib/logger";

/**
 * Extracts data from the provided URLs based on the request parameters.
 * Currently in beta.
 * @param req - The request object containing authentication and extraction details.
 * @param res - The response object to send the extraction results.
 * @returns A promise that resolves when the extraction process is complete.
 */
export async function extractController(
  req: RequestWithAuth<{}, ExtractResponse, ExtractRequest>,
  res: Response<ExtractResponse>,
) {
  const originalRequest = { ...req.body };
  req.body = extractRequestSchema.parse(req.body);

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on extract. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const invalidURLs: string[] =
    req.body.urls?.filter((url: string) =>
      isUrlBlocked(url, req.acuc?.flags ?? null),
    ) ?? [];

  if (invalidURLs.length > 0 && !req.body.ignoreInvalidURLs) {
    if (!res.headersSent) {
      return res.status(403).json({
        success: false,
        error: BLOCKLISTED_URL_MESSAGE,
      });
    }
  }

  const extractId = uuidv7();
  const createdAt = Date.now();
  _logger.info("Extract starting...", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    subId: req.acuc?.sub_id,
    extractId,
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  const jobData = {
    request: req.body,
    teamId: req.auth.team_id,
    subId: req.acuc?.sub_id,
    extractId,
    agent: req.body.agent,
    createdAt,
  };

  await saveExtract(extractId, {
    id: extractId,
    team_id: req.auth.team_id,
    createdAt,
    status: "processing",
    showSteps: req.body.__experimental_streamSteps,
    showLLMUsage: req.body.__experimental_llmUsage,
    showSources: req.body.__experimental_showSources || req.body.showSources,
    showCostTracking: req.body.__experimental_showCostTracking,
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  await getExtractQueue().add(extractId, jobData, {
    jobId: extractId,
  });

  return res.status(200).json({
    success: true,
    id: extractId,
    urlTrace: [],
    ...(invalidURLs.length > 0 && req.body.ignoreInvalidURLs
      ? {
          invalidURLs,
        }
      : {}),
  });
}
