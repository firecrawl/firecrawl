import { Response } from "express";
import { z } from "zod";
import { logger as _logger } from "../../lib/logger";
import {
  RequestWithAuth,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
  searchFeedbackSchema,
} from "./types";
import { recordEndpointFeedback } from "./feedback/record";
import { searchFeedbackRecordOptions } from "./feedback/record-options";
import { toSearchFeedbackInput } from "./feedback/request-input";

export async function searchFeedbackController(
  req: RequestWithAuth<
    { jobId: string },
    SearchFeedbackResponse,
    SearchFeedbackRequest
  >,
  res: Response<SearchFeedbackResponse>,
) {
  const searchId = req.params.jobId;
  const logger = _logger.child({
    module: "api/v2",
    method: "searchFeedbackController",
    searchId,
    teamId: req.auth.team_id,
  });

  let parsedBody: SearchFeedbackRequest;
  try {
    parsedBody = searchFeedbackSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid feedback body", { error: error.issues });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
        feedbackErrorCode: "INVALID_BODY",
      });
    }
    throw error;
  }

  const result = await recordEndpointFeedback(
    req,
    searchFeedbackRecordOptions({
      jobId: searchId,
      feedback: toSearchFeedbackInput(parsedBody),
    }),
  );

  return res.status(result.status).json(result.body);
}
