import { Request, Response } from "express";
import {
  RequestWithAuth,
  ExtractRequest,
  extractRequestSchema,
  ExtractResponse,
} from "./types";
import { getExtractQueue } from "../../services/queue-service";
import { saveExtract } from "../../lib/extract/extract-redis";
import { getTeamIdSyncB } from "../../lib/extract/team-id-sync";
import {
  ExtractResult,
  performExtraction,
} from "../../lib/extract/extraction-service";
import { performExtraction_F0 } from "../../lib/extract/fire-0/extraction-service-f0";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { logger as _logger } from "../../lib/logger";
import { fromV1ScrapeOptions } from "../v2/types";
import { createWebhookSender, WebhookEvent } from "../../services/webhook";

async function oldExtract(
  req: RequestWithAuth<{}, ExtractResponse, ExtractRequest>,
  res: Response<ExtractResponse>,
  extractId: string,
) {
  // Means that are in the non-queue system
  // TODO: Remove this once all teams have transitioned to the new system

  const sender = await createWebhookSender({
    teamId: req.auth.team_id,
    jobId: extractId,
    webhook: req.body.webhook,
    v0: false,
  });

  sender?.send(WebhookEvent.EXTRACT_STARTED, { success: true });

  try {
    let result: ExtractResult;
    const model = req.body.agent?.model;
    if (req.body.agent && model && model.toLowerCase().includes("fire-1")) {
      result = await performExtraction(extractId, {
        request: req.body,
        teamId: req.auth.team_id,
        subId: req.acuc?.sub_id ?? undefined,
        apiKeyId: req.acuc?.api_key_id ?? null,
      });
    } else {
      result = await performExtraction_F0(extractId, {
        request: req.body,
        teamId: req.auth.team_id,
        subId: req.acuc?.sub_id ?? undefined,
        apiKeyId: req.acuc?.api_key_id ?? null,
      });
    }

    if (sender) {
      if (result.success) {
        sender.send(WebhookEvent.EXTRACT_COMPLETED, {
          success: true,
          data: [result],
        });
      } else {
        sender.send(WebhookEvent.EXTRACT_FAILED, {
          success: false,
          error: result.error ?? "Unknown error",
        });
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    sender?.send(WebhookEvent.EXTRACT_FAILED, {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
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
  const selfHosted = process.env.USE_DB_AUTHENTICATION !== "true";
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

  const createdAt = Date.now();

  if (invalidURLs.length > 0 && !req.body.ignoreInvalidURLs) {
    if (!res.headersSent) {
      return res.status(403).json({
        success: false,
        error: BLOCKLISTED_URL_MESSAGE,
      });
    }
  }

  const extractId = crypto.randomUUID();

  _logger.info("Extract starting...", {
    request: req.body,
    originalRequest,
    teamId: req.auth.team_id,
    team_id: req.auth.team_id,
    subId: req.acuc?.sub_id,
    extractId,
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  const scrapeOptions = req.body.scrapeOptions
    ? fromV1ScrapeOptions(
        req.body.scrapeOptions,
        req.body.scrapeOptions.timeout,
        req.auth.team_id,
      ).scrapeOptions
    : undefined;

  const jobData = {
    request: {
      ...req.body,
      scrapeOptions,
    },
    teamId: req.auth.team_id,
    subId: req.acuc?.sub_id,
    extractId,
    agent: req.body.agent,
    apiKeyId: req.acuc?.api_key_id ?? null,
    createdAt,
  };

  if (
    (await getTeamIdSyncB(req.auth.team_id)) &&
    req.body.origin !== "api-sdk" &&
    req.body.origin !== "website" &&
    !req.body.origin.startsWith("python-sdk@") &&
    !req.body.origin.startsWith("js-sdk@")
  ) {
    return await oldExtract(req, res, extractId);
  }

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
