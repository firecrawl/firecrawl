import { Response } from "express";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { config } from "../../config";
import { logger as _logger } from "../../lib/logger";
import { autumnService } from "../../services/autumn/autumn.service";
import {
  isPostgrestNoRowsError,
  supabase_service,
  supabase_rr_service,
} from "../../services/supabase";
import { captureExceptionWithZdrCheck } from "../../services/sentry";
import {
  RequestWithAuth,
  SearchFeedbackErrorCode,
  SearchFeedbackRequest,
  SearchFeedbackResponse,
  searchFeedbackSchema,
} from "./types";

export const SEARCH_FEEDBACK_REFUND_CREDITS = 1;

// Must match the previewTeamId in services/logging/log_job.ts.
const PREVIEW_TEAM_ID = "3adefd26-77ec-5968-8dcf-c94b5630d1de";

const POSTGRES_UNIQUE_VIOLATION = "23505";

// logSearch in the search controller is fire-and-forget; this retry covers
// the gap when feedback arrives before the searches row has been inserted.
const SEARCH_LOOKUP_RACE_RETRY_MS = 250;

type FailReason = {
  status: number;
  code: SearchFeedbackErrorCode;
  error: string;
};

function fail(
  res: Response<SearchFeedbackResponse>,
  reason: FailReason,
): Response<SearchFeedbackResponse> {
  return res.status(reason.status).json({
    success: false,
    error: reason.error,
    feedbackErrorCode: reason.code,
  });
}

function isPreviewTeam(teamId: string): boolean {
  return teamId === "preview" || teamId.startsWith("preview_");
}

function normalizeTeamId(teamId: string): string {
  return isPreviewTeam(teamId) ? PREVIEW_TEAM_ID : teamId;
}

type SearchRowForFeedback = {
  id: string;
  team_id: string;
  credits_cost: number | null;
  created_at: string;
  is_successful: boolean | null;
};

async function lookupSearchRow(
  searchId: string,
  dbTeamId: string,
): Promise<SearchRowForFeedback | null> {
  const { data, error } = await supabase_rr_service
    .from("searches")
    .select("id, team_id, credits_cost, created_at, is_successful")
    .eq("id", searchId)
    .eq("team_id", dbTeamId)
    .single();

  if (error) {
    if (isPostgrestNoRowsError(error)) return null;
    throw error;
  }
  return data as SearchRowForFeedback | null;
}

function startOfUtcDay(now: Date = new Date()): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

// Best-effort: on DB error we return 0 rather than block legitimate
// refunds; overshoot is bounded by the rate limiter.
async function sumTeamCreditsRefundedToday(
  dbTeamId: string,
  logger: ReturnType<typeof _logger.child>,
): Promise<number> {
  const since = startOfUtcDay().toISOString();

  const { data, error } = await supabase_rr_service
    .from("search_feedback")
    .select("credits_refunded")
    .eq("team_id", dbTeamId)
    .gte("created_at", since);

  if (error) {
    logger.warn(
      "Failed to compute today's refund total; allowing refund this call",
      { error },
    );
    return 0;
  }

  return (data ?? []).reduce(
    (sum, row: { credits_refunded: number | null }) =>
      sum + (row.credits_refunded ?? 0),
    0,
  );
}

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

  if (config.USE_DB_AUTHENTICATION !== true) {
    return fail(res, {
      status: 503,
      code: "DB_DISABLED",
      error:
        "Search feedback requires database authentication and is unavailable on this deployment.",
    });
  }

  // Preview tenants share one team_id in the searches table, so one
  // preview agent could otherwise submit feedback on another's searches.
  if (isPreviewTeam(req.auth.team_id)) {
    return fail(res, {
      status: 403,
      code: "PREVIEW_TEAM_NOT_ALLOWED",
      error: "Search feedback is not available for preview teams.",
    });
  }

  if (req.acuc?.flags?.searchFeedbackOptOut === true) {
    logger.info("Rejected feedback: team opted out");
    return fail(res, {
      status: 403,
      code: "TEAM_OPTED_OUT",
      error:
        "Search feedback is disabled for this team. Contact support@firecrawl.com to re-enable.",
    });
  }

  const dbTeamId = normalizeTeamId(req.auth.team_id);

  try {
    let searchRow: SearchRowForFeedback | null;
    try {
      searchRow = await lookupSearchRow(searchId, dbTeamId);
      if (!searchRow) {
        await new Promise(resolve =>
          setTimeout(resolve, SEARCH_LOOKUP_RACE_RETRY_MS),
        );
        searchRow = await lookupSearchRow(searchId, dbTeamId);
      }
    } catch (lookupErr) {
      logger.error("Failed to look up search for feedback", {
        error: lookupErr,
      });
      return fail(res, {
        status: 500,
        code: "INTERNAL",
        error: "Failed to look up search.",
      });
    }

    if (!searchRow) {
      return fail(res, {
        status: 404,
        code: "SEARCH_NOT_FOUND",
        error: "Search not found for this team.",
      });
    }

    if (searchRow.is_successful === false) {
      return fail(res, {
        status: 409,
        code: "SEARCH_FAILED",
        error:
          "Cannot submit feedback for a search that did not succeed.",
      });
    }

    const maxAgeMs = config.SEARCH_FEEDBACK_MAX_AGE_SEC * 1000;
    const createdAtMs = new Date(searchRow.created_at).getTime();
    if (Number.isNaN(createdAtMs)) {
      logger.warn("Search row had unparseable created_at", {
        created_at: searchRow.created_at,
      });
    } else {
      const ageMs = Date.now() - createdAtMs;
      if (ageMs > maxAgeMs) {
        logger.info("Rejected feedback outside time window", {
          ageMs,
          maxAgeMs,
        });
        return fail(res, {
          status: 409,
          code: "FEEDBACK_WINDOW_EXPIRED",
          error: `Search feedback must be submitted within ${config.SEARCH_FEEDBACK_MAX_AGE_SEC} seconds of the search.`,
        });
      }
    }

    const feedbackId = uuidv7();
    const { error: insertErr } = await supabase_service
      .from("search_feedback")
      .insert({
        id: feedbackId,
        search_id: searchId,
        team_id: dbTeamId,
        overall_rating: parsedBody.rating,
        valuable_sources: parsedBody.valuableSources ?? [],
        missing_content: parsedBody.missingContent ?? [],
        query_suggestions: parsedBody.querySuggestions ?? null,
        integration: parsedBody.integration ?? null,
        origin: parsedBody.origin ?? null,
        credits_refunded: 0,
      });

    if (insertErr) {
      if ((insertErr as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        const { data: existing } = await supabase_rr_service
          .from("search_feedback")
          .select("id, credits_refunded")
          .eq("search_id", searchId)
          .single();

        const dailyCapForResponse = config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS;
        const refundedTodayForResponse = await sumTeamCreditsRefundedToday(
          dbTeamId,
          logger,
        );

        return res.status(200).json({
          success: true,
          feedbackId: existing?.id ?? "",
          creditsRefunded: 0,
          alreadySubmitted: true,
          creditsRefundedToday: refundedTodayForResponse,
          dailyRefundCap: dailyCapForResponse,
          warning:
            "Feedback was already submitted for this search; no additional refund issued.",
        });
      }

      logger.error("Failed to insert search feedback", { error: insertErr });
      return fail(res, {
        status: 500,
        code: "INTERNAL",
        error: "Failed to record feedback.",
      });
    }

    // The just-inserted row has credits_refunded=0, so reading the SUM
    // here is safe whether or not it shows up in the read replica yet.
    const dailyCap = config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS;
    const refundedTodayBefore = await sumTeamCreditsRefundedToday(
      dbTeamId,
      logger,
    );
    const remainingDailyCap = Math.max(0, dailyCap - refundedTodayBefore);

    let creditsRefunded = 0;
    let dailyCapReached = false;
    const billedCredits = searchRow.credits_cost ?? 0;

    const desiredRefund = Math.min(
      SEARCH_FEEDBACK_REFUND_CREDITS,
      billedCredits,
    );
    const cappedRefund = Math.min(desiredRefund, remainingDailyCap);

    if (billedCredits > 0 && desiredRefund > 0 && cappedRefund === 0) {
      dailyCapReached = true;
      logger.info(
        "Daily refund cap reached for team; feedback recorded with zero refund",
        {
          dailyCap,
          refundedTodayBefore,
        },
      );
    } else if (cappedRefund > 0) {
      try {
        await autumnService.refundCredits({
          teamId: req.auth.team_id,
          value: cappedRefund,
          properties: {
            source: "search_feedback",
            endpoint: "search",
            jobId: searchId,
            feedbackId,
            rating: parsedBody.rating,
          },
        });
        creditsRefunded = cappedRefund;
      } catch (error) {
        logger.error("Search feedback refund failed; feedback retained", {
          error,
        });
      }

      if (creditsRefunded > 0) {
        const { error: updateErr } = await supabase_service
          .from("search_feedback")
          .update({ credits_refunded: creditsRefunded })
          .eq("id", feedbackId);
        if (updateErr) {
          logger.warn(
            "Failed to persist credits_refunded on search_feedback row",
            { error: updateErr, feedbackId, creditsRefunded },
          );
        }
      }
    }

    const creditsRefundedToday = refundedTodayBefore + creditsRefunded;
    if (!dailyCapReached && creditsRefundedToday >= dailyCap && dailyCap > 0) {
      dailyCapReached = true;
    }

    logger.info("Search feedback recorded", {
      feedbackId,
      creditsRefunded,
      rating: parsedBody.rating,
      valuableSourcesCount: parsedBody.valuableSources?.length ?? 0,
      missingContentCount: parsedBody.missingContent?.length ?? 0,
      hasQuerySuggestions: !!parsedBody.querySuggestions,
      creditsRefundedToday,
      dailyRefundCap: dailyCap,
      dailyCapReached,
    });

    return res.status(200).json({
      success: true,
      feedbackId,
      creditsRefunded,
      creditsRefundedToday,
      dailyRefundCap: dailyCap,
      ...(dailyCapReached
        ? {
            dailyCapReached: true,
            warning: `Daily refund cap of ${dailyCap} credits reached for this team (UTC day). Feedback was recorded; further /feedback calls today will not refund credits.`,
          }
        : {}),
    });
  } catch (error) {
    captureExceptionWithZdrCheck(error);
    logger.error("Unhandled error in search feedback controller", { error });
    return fail(res, {
      status: 500,
      code: "INTERNAL",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
