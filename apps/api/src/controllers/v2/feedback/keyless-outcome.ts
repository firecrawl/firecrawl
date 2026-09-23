import { z } from "zod";
import { logger } from "../../../lib/logger";

const endpoints = new Set(["search", "scrape", "parse"]);
const jobIdSchema = z.uuid();

// Records how a submission ended using job references only. Submitted feedback
// content never enters this event.
export function logKeylessFeedbackOutcome(event: {
  identity: string;
  outcome: "accepted" | "duplicate" | "rejected";
  status: number;
  body: unknown;
  feedbackId?: string;
  feedbackErrorCode?: string;
  reason?: "disabled" | "attempt_limit" | "limiter_unavailable";
}) {
  const submitted = (event.body ?? {}) as {
    endpoint?: unknown;
    jobId?: unknown;
  };
  const fields = {
    canonicalLog: "keyless/feedback_submission",
    outcome: event.outcome,
    status: event.status,
    identity: event.identity,
    endpoint:
      typeof submitted.endpoint === "string" &&
      endpoints.has(submitted.endpoint)
        ? submitted.endpoint
        : null,
    jobId: jobIdSchema.safeParse(submitted.jobId).success
      ? submitted.jobId
      : null,
    feedbackId: event.feedbackId ?? null,
    feedbackErrorCode: event.feedbackErrorCode ?? null,
    reason: event.reason ?? null,
  };
  if (event.status >= 500) logger.warn("Keyless feedback submission", fields);
  else logger.info("Keyless feedback submission", fields);
}
