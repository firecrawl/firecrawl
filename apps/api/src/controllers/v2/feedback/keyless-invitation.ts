import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { logger } from "../../../lib/logger";
import type { RequestWithAuth } from "../types";
import type { KeylessFeedbackEndpoint } from "./keyless-schema";
import { isKeylessFeedbackRestricted } from "./zdr-persistence";
import {
  KEYLESS_FEEDBACK_MAX_AGE_SEC,
  KEYLESS_FEEDBACK_MAX_FUTURE_SKEW_SEC,
} from "./keyless-limits";
import { lookupJobWithRetry } from "./record";

export async function keylessFeedbackMetadata(
  req: RequestWithAuth<any, any, any>,
  endpoint: KeylessFeedbackEndpoint,
  jobId: string,
): Promise<Record<string, unknown>> {
  const identity = keylessTeamUuid(req.auth.team_id);
  if (!identity) return {};
  const reference = { jobId };
  if (
    !config.KEYLESS_FEEDBACK_ENABLED ||
    !config.USE_DB_AUTHENTICATION ||
    isKeylessFeedbackRestricted(endpoint, req.body)
  )
    return reference;

  // Logging is best effort. Invite only when the row needed by feedback exists.
  const job = await lookupJobWithRetry({ endpoint, jobId }, identity, logger, {
    requireOptions: true,
  });
  if ("status" in job || isKeylessFeedbackRestricted(endpoint, job.options))
    return reference;
  const createdAt = new Date(job.created_at).getTime();
  const expiresAt = createdAt + KEYLESS_FEEDBACK_MAX_AGE_SEC * 1000;
  if (
    !Number.isFinite(createdAt) ||
    createdAt > Date.now() + KEYLESS_FEEDBACK_MAX_FUTURE_SKEW_SEC * 1000 ||
    expiresAt <= Date.now()
  )
    return reference;

  req.res?.once("finish", () => {
    logger.info("Keyless feedback invitation issued", {
      canonicalLog: "keyless/feedback_invitation",
      invited: true,
      issuedAt: new Date().toISOString(),
      identity,
      endpoint,
      jobId,
      origin:
        typeof req.body?.origin === "string"
          ? req.body.origin.slice(0, 100)
          : "api",
      integration:
        typeof req.body?.integration === "string"
          ? req.body.integration.slice(0, 100)
          : null,
    });
  });
  return {
    ...reference,
    feedback: {
      endpoint,
      jobId,
      method: "POST",
      path: "/v2/feedback",
      docs: "https://docs.firecrawl.dev/api-reference/endpoint/feedback",
      expiresAt: new Date(expiresAt).toISOString(),
      message:
        "Consider submitting feedback to POST /v2/feedback, especially if this result is wrong, incomplete, blocked, or an error. Include specific evidence to help improve Firecrawl.",
    },
  };
}
