import { v7 as uuidv7 } from "uuid";
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
  const { rating, origin, integration, ...metadata } = body;
  try {
    await db.insert(schema.search_feedback).values({
      id: feedbackId,
      endpoint: "alexandria",
      team_id: teamId,
      api_key_id: req.acuc?.api_key_id ?? null,
      search_id: null,
      job_id: null,
      request_id: null,
      job_status: null,
      api_version: "v2",
      overall_rating: rating,
      comment: body.rationale,
      metadata: { schemaVersion: 1, ...metadata },
      origin,
      integration: integration ?? null,
      credits_billed: 0,
      credits_refunded: 0,
      refund_policy: null,
    });
  } catch {
    // Database errors may embed the submitted payload. Keep feedback content
    // out of logs, including on failed writes.
    logger.error("Failed to record Alexandria feedback", { feedbackId });
    return failure(500, "INTERNAL", "Failed to record feedback.");
  }
  return {
    status: 200,
    body: { success: true, feedbackId, creditsRefunded: 0 },
  };
}
