import { randomUUID } from "node:crypto";
import type { EndpointFeedbackRequest } from "../../controllers/v2/types";
import { exchangeRequest } from "./client";

type AlexandriaFeedbackRequest = Extract<
  EndpointFeedbackRequest,
  { target: { type: "alexandria_result" | "alexandria_catalog" } }
>;
type AlexandriaResultFeedbackRequest = Extract<
  AlexandriaFeedbackRequest,
  { target: { type: "alexandria_result" } }
>;

function isResultFeedback(
  feedback: AlexandriaFeedbackRequest,
): feedback is AlexandriaResultFeedbackRequest {
  return feedback.target.type === "alexandria_result";
}

export async function submitAlexandriaFeedback(input: {
  teamId: string;
  requestId?: string;
  feedback: AlexandriaFeedbackRequest;
}) {
  const feedback = input.feedback;
  const body = isResultFeedback(feedback)
    ? {
        kind: "result",
        feedbackRef: feedback.target.feedbackRef,
        rating: feedback.rating,
        issues: feedback.issues,
        note: feedback.note,
        origin: feedback.origin,
        integration: feedback.integration,
      }
    : {
        kind: "coverage_request",
        request: feedback.request,
        note: feedback.note,
        origin: feedback.origin,
        integration: feedback.integration,
      };

  return exchangeRequest({
    teamId: input.teamId,
    path: "/v1/feedback",
    body,
    timeoutMs: 10_000,
    requestId: input.requestId ?? randomUUID(),
  });
}
