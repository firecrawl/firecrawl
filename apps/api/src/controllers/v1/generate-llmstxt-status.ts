import { Response } from "express";
import { RequestWithAuth } from "./types";
import {
  getGeneratedLlmsTxt,
  getGeneratedLlmsTxtExpiry,
} from "../../lib/generate-llmstxt/generate-llmstxt-redis";
import { supabaseGetJobsById } from "../../lib/supabase-jobs";

export async function generateLLMsTextStatusController(
  req: RequestWithAuth<{ jobId: string }, any, any>,
  res: Response,
) {
  const generation = await getGeneratedLlmsTxt(req.params.jobId);
  const showFullText = generation?.showFullText ?? false;

  if (!generation) {
    return res.status(404).json({
      success: false,
      error: "llmsTxt generation job not found",
    });
  }

  let data: any = null;

  if (showFullText) {
    data = {
      llmstxt: generation.generatedText,
      llmsfulltxt: generation.fullText,
    };
  } else {
    data = {
      llmstxt: generation.generatedText,
    };
  }

  return res.status(200).json({
    success: generation.status === "failed" ? false : true,

    data: data,
    status: generation.status,
    error: generation?.error ?? undefined,
    expiresAt: (
      await getGeneratedLlmsTxtExpiry(req.params.jobId)
    ).toISOString(),
  });
}
