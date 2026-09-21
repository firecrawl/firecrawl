import { Response } from "express";
import { z } from "zod";
import {
  EndpointFeedbackRequest,
  EndpointFeedbackResponse,
  RequestWithAuth,
  endpointFeedbackSchema,
} from "../types";
import { recordEndpointFeedback } from "./record";
import { endpointFeedbackRecordOptions } from "./record-options";
import { toFeedbackInput } from "./request-input";
import {
  alexandriaFeedbackSchema,
  AlexandriaFeedbackRequest,
} from "./alexandria-schema";
import { recordAlexandriaFeedback } from "./alexandria";

const feedbackSchema = z.union([
  alexandriaFeedbackSchema,
  endpointFeedbackSchema,
]);

export async function feedbackController(
  req: RequestWithAuth<
    {},
    EndpointFeedbackResponse,
    EndpointFeedbackRequest | AlexandriaFeedbackRequest
  >,
  res: Response<EndpointFeedbackResponse>,
) {
  let parsedBody: EndpointFeedbackRequest | AlexandriaFeedbackRequest;
  try {
    parsedBody = feedbackSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
        feedbackErrorCode: "INVALID_BODY",
      });
    }
    throw error;
  }

  if ("categories" in parsedBody) {
    const result = await recordAlexandriaFeedback(req, parsedBody);
    return res.status(result.status).json(result.body);
  }

  const result = await recordEndpointFeedback(
    req,
    endpointFeedbackRecordOptions({
      endpoint: parsedBody.endpoint,
      jobId: parsedBody.jobId,
      feedback: toFeedbackInput(parsedBody),
    }),
  );

  return res.status(result.status).json(result.body);
}
