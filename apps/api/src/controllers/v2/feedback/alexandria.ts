import { v7 as uuidv7 } from "uuid";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { config } from "../../../config";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { logger } from "../../../lib/logger";
import { getScrapeZDR, getSearchZDR } from "../../../lib/zdr-helpers";
import type { RequestWithAuth, EndpointFeedbackErrorCode } from "../types";
import type { FeedbackRecordResult } from "./internal-types";
import type { AlexandriaFeedbackRequest } from "./alexandria-schema";

const failure = (
  status: number,
  feedbackErrorCode: EndpointFeedbackErrorCode,
  error: string,
): FeedbackRecordResult => ({
  status,
  body: { success: false, feedbackErrorCode, error },
});

export async function recordAlexandriaFeedback(
  req: RequestWithAuth<any, any, any>,
  body: AlexandriaFeedbackRequest,
): Promise<FeedbackRecordResult> {
  if (!config.USE_DB_AUTHENTICATION) {
    return failure(
      503,
      "DB_DISABLED",
      "Feedback requires database authentication.",
    );
  }
  const teamId = req.auth.team_id;
  if (teamId === "preview" || teamId.startsWith("preview_")) {
    return failure(
      403,
      "PREVIEW_TEAM_NOT_ALLOWED",
      "Feedback is not available for preview teams.",
    );
  }
  if (req.acuc?.flags?.searchFeedbackOptOut === true) {
    return failure(
      403,
      "TEAM_OPTED_OUT",
      "Feedback is disabled for this team. Contact support@firecrawl.com to re-enable.",
    );
  }

  // A session can contain both search and scrape data. Honor either forced
  // retention policy without looking up or recording individual jobs.
  const searchZdr = getSearchZDR(req.acuc?.flags);
  if (
    getScrapeZDR(req.acuc?.flags) === "forced" ||
    searchZdr === "forced-zdr" ||
    searchZdr === "forced-anon"
  ) {
    return {
      status: 200,
      body: {
        success: true,
        feedbackId: "00000000-0000-0000-0000-000000000000",
        creditsRefunded: 0,
      },
    };
  }

  const feedbackId = uuidv7();
  const providerRows = (body.providerFeedback ?? []).map((entry, position) => ({
    feedback_id: feedbackId,
    team_id: teamId,
    position,
    name: entry.name,
    issue: entry.issue,
    why: entry.why,
  }));
  const capabilityRows = (body.capabilityFeedback ?? []).map(
    (entry, position) => ({
      feedback_id: feedbackId,
      team_id: teamId,
      position,
      name: entry.name,
      provider: entry.provider,
      issue: entry.issue,
      why: entry.why,
      requested_functionality: entry.requestedFunctionality ?? null,
    }),
  );
  try {
    await db.transaction(async tx => {
      await tx.insert(schema.alexandria_feedback).values({
        id: feedbackId,
        team_id: teamId,
        api_key_id: req.acuc?.api_key_id ?? null,
        api_version: "v2",
        rating: body.rating,
        requested_url: body.requestedWebsite.url,
        requested_functionality: body.requestedWebsite.requestedFunctionality,
        rationale: body.rationale,
        origin: body.origin,
        integration: body.integration ?? null,
        schema_version: 2,
      });
      if (providerRows.length > 0) {
        await tx
          .insert(schema.alexandria_feedback_providers)
          .values(providerRows);
      }
      if (capabilityRows.length > 0) {
        await tx
          .insert(schema.alexandria_feedback_capabilities)
          .values(capabilityRows);
      }
    });
  } catch (error) {
    // Database errors may embed the submitted payload. Keep feedback content
    // out of logs; only retain the underlying PostgreSQL SQLSTATE.
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    const code =
      cause !== null && typeof cause === "object" && "code" in cause
        ? cause.code
        : undefined;
    logger.error("Failed to record Alexandria feedback", {
      feedbackId,
      errorCode:
        typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null,
    });
    return failure(500, "INTERNAL", "Failed to record feedback.");
  }
  return {
    status: 200,
    body: { success: true, feedbackId, creditsRefunded: 0 },
  };
}
