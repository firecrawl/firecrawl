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
import { submitAlexandriaFeedback } from "../../../services/alexandria/feedback";

type AlexandriaFeedbackRequest = Extract<
  EndpointFeedbackRequest,
  { target: { type: "alexandria_result" | "alexandria_catalog" } }
>;
type FirecrawlTargetFeedbackRequest = Extract<
  EndpointFeedbackRequest,
  { target: { type: "firecrawl_job" } }
>;

function isAlexandriaFeedback(
  body: EndpointFeedbackRequest,
): body is AlexandriaFeedbackRequest {
  return (
    "target" in body &&
    (body.target.type === "alexandria_result" ||
      body.target.type === "alexandria_catalog")
  );
}

function isFirecrawlTargetFeedback(
  body: EndpointFeedbackRequest,
): body is FirecrawlTargetFeedbackRequest {
  return "target" in body && body.target.type === "firecrawl_job";
}

export async function feedbackController(
  req: RequestWithAuth<{}, EndpointFeedbackResponse, EndpointFeedbackRequest>,
  res: Response<EndpointFeedbackResponse>,
) {
  let parsedBody: EndpointFeedbackRequest;
  try {
    parsedBody = endpointFeedbackSchema.parse(req.body);
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

  if (isAlexandriaFeedback(parsedBody)) {
    try {
      const upstream = await submitAlexandriaFeedback({
        teamId: req.auth.team_id,
        requestId: req.get("x-request-id"),
        feedback: parsedBody,
      });
      const body = upstream.body as Record<string, unknown> | null;
      if (
        upstream.status >= 200 &&
        upstream.status < 300 &&
        body?.success === true &&
        typeof body.feedbackId === "string"
      ) {
        return res.status(200).json({
          success: true,
          feedbackId: body.feedbackId,
          creditsRefunded: 0,
          ...(body.alreadySubmitted === true ? { alreadySubmitted: true } : {}),
          ...(typeof body.provider === "string"
            ? { provider: body.provider }
            : {}),
          ...(typeof body.capability === "string"
            ? { capability: body.capability }
            : {}),
        });
      }

      const nested =
        body?.error && typeof body.error === "object"
          ? (body.error as Record<string, unknown>)
          : null;
      return res.status(upstream.status >= 500 ? 502 : upstream.status).json({
        success: false,
        error:
          (typeof nested?.message === "string" && nested.message) ||
          (typeof body?.error === "string" && body.error) ||
          "Alexandria feedback could not be recorded.",
        feedbackErrorCode:
          nested?.code === "feedback_target_not_found"
            ? "JOB_NOT_FOUND"
            : "ALEXANDRIA_UNAVAILABLE",
      });
    } catch {
      return res.status(503).json({
        success: false,
        error: "Alexandria feedback is temporarily unavailable.",
        feedbackErrorCode: "ALEXANDRIA_UNAVAILABLE",
      });
    }
  }

  const endpoint =
    "endpoint" in parsedBody
      ? parsedBody.endpoint
      : isFirecrawlTargetFeedback(parsedBody)
        ? parsedBody.target.endpoint
        : undefined;
  const jobId =
    "jobId" in parsedBody
      ? parsedBody.jobId
      : isFirecrawlTargetFeedback(parsedBody)
        ? parsedBody.target.jobId
        : undefined;
  if (endpoint === undefined || jobId === undefined) {
    throw new Error("Unreachable feedback target");
  }
  const result = await recordEndpointFeedback(
    req,
    endpointFeedbackRecordOptions({
      endpoint,
      jobId,
      feedback: toFeedbackInput(parsedBody),
    }),
  );

  return res.status(result.status).json(result.body);
}
