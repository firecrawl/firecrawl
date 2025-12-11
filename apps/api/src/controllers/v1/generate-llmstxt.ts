import { v7 as uuidv7 } from "uuid";
import { Response } from "express";
import {
  ErrorResponse,
  GenerateLLMsTextRequest,
  generateLLMsTextRequestSchema,
  RequestWithAuth,
} from "./types";
import { getGenerateLlmsTxtQueue } from "../../services/queue-service";
import * as Sentry from "@sentry/node";
import { saveGeneratedLlmsTxt } from "../../lib/generate-llmstxt/generate-llmstxt-redis";
import { logRequest } from "../../services/logging/log_job";

type GenerateLLMsTextResponse =
  | ErrorResponse
  | {
      success: boolean;
      id: string;
    };

/**
 * Initiates a text generation job based on the provided URL.
 * @param req - The request object containing authentication and generation parameters.
 * @param res - The response object to send the generation job ID.
 * @returns A promise that resolves when the generation job is queued.
 */
export async function generateLLMsTextController(
  req: RequestWithAuth<{}, GenerateLLMsTextResponse, GenerateLLMsTextRequest>,
  res: Response<GenerateLLMsTextResponse>,
) {
  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on llmstxt. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  req.body = generateLLMsTextRequestSchema.parse(req.body);

  const generationId = uuidv7();

  await logRequest({
    id: generationId,
    kind: "llmstxt",
    api_version: "v1",
    team_id: req.auth.team_id,
    origin: "api", // no origin field for llmstxt
    target_hint: req.body.url,
    zeroDataRetention: false, // not supported for llmstxt
    api_key_id: req.acuc?.api_key_id ?? null,
  });

  const jobData = {
    request: req.body,
    teamId: req.auth.team_id,
    subId: req.acuc?.sub_id ?? undefined,
    apiKeyId: req.acuc?.api_key_id ?? null,
    generationId,
  };

  await saveGeneratedLlmsTxt(generationId, {
    id: generationId,
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    status: "processing",
    url: req.body.url,
    maxUrls: req.body.maxUrls,
    showFullText: req.body.showFullText,
    cache: req.body.cache,
    generatedText: "",
    fullText: "",
  });

  await getGenerateLlmsTxtQueue().add(generationId, jobData, {
    jobId: generationId,
  });

  return res.status(200).json({
    success: true,
    id: generationId,
  });
}
