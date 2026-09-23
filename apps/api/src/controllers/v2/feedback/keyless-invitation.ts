import { config } from "../../../config";
import { keylessTeamUuid } from "../../../lib/keyless";
import { logger } from "../../../lib/logger";
import type { RequestWithAuth } from "../types";
import type { KeylessFeedbackEndpoint } from "./keyless-schema";
import { isKeylessFeedbackRestricted } from "./zdr-persistence";
import { KEYLESS_FEEDBACK_MAX_AGE_SEC } from "./keyless-limits";

export function keylessFeedbackMetadata(
  req: RequestWithAuth<any, any, any>,
  endpoint: KeylessFeedbackEndpoint,
  jobId: string,
): Record<string, unknown> {
  const identity = keylessTeamUuid(req.auth.team_id);
  if (!identity) return {};
  const reference = { jobId };
  if (
    !config.KEYLESS_FEEDBACK_ENABLED ||
    !config.USE_DB_AUTHENTICATION ||
    req.acuc?.flags?.searchFeedbackOptOut ||
    isKeylessFeedbackRestricted(endpoint, req.body, req.acuc?.flags)
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
      expiresAt: new Date(
        Date.now() + KEYLESS_FEEDBACK_MAX_AGE_SEC * 1000,
      ).toISOString(),
      message:
        "Keyless Firecrawl is free in exchange for feedback. Please submit feedback on this result with specific evidence you observed.",
    },
  };
}
