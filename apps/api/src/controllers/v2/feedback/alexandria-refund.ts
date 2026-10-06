import { and, eq, gt, gte } from "drizzle-orm";
import { config } from "../../../config";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { logger as _logger } from "../../../lib/logger";
import {
  autumnService,
  CREDITS_FEATURE_ID,
} from "../../../services/autumn/autumn.service";
import type { FeedbackRating, RefundPolicySnapshot } from "./internal-types";

const REFUND_CREDITS = 1;
const REFUNDABLE_RATINGS: FeedbackRating[] = ["good", "partial", "bad"];

type RefundOutcome =
  | "alexandria_feedback"
  | "refunds_disabled"
  | "refund_totals_unavailable"
  | "host_already_refunded_today"
  | "daily_cap_reached";

type AlexandriaRefundResult = {
  creditsRefunded: number;
  creditsRefundedToday: number;
  dailyRefundCap: number;
  alreadySubmitted?: boolean;
  dailyCapReached?: boolean;
  warning?: string;
};

function startOfUtcDay(now: Date): Date {
  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function policyFor(outcome: RefundOutcome): RefundPolicySnapshot {
  const refunds = outcome === "alexandria_feedback";
  return {
    version: "feedback_refund_v1",
    enabled: config.FEEDBACK_REFUND_ENABLED,
    endpoint: "alexandria",
    mode: refunds ? "flat" : "none",
    refundableRatings: REFUNDABLE_RATINGS,
    matchedReason: outcome,
    ...(refunds
      ? { flatCredits: REFUND_CREDITS, maxCredits: REFUND_CREDITS }
      : {}),
  };
}

/** Today's refunded Alexandria feedback for the team, read from the primary. */
async function refundsToday(
  teamId: string,
  now: Date,
): Promise<{ total: number; hosts: Set<string> }> {
  const rows = await db
    .select({
      requested_host: schema.alexandria_feedback.requested_host,
      credits_refunded: schema.alexandria_feedback.credits_refunded,
    })
    .from(schema.alexandria_feedback)
    .where(
      and(
        eq(schema.alexandria_feedback.team_id, teamId),
        gte(
          schema.alexandria_feedback.created_at,
          startOfUtcDay(now).toISOString(),
        ),
        gt(schema.alexandria_feedback.credits_refunded, 0),
      ),
    );
  return {
    total: rows.reduce((sum, row) => sum + (row.credits_refunded ?? 0), 0),
    hosts: new Set(
      rows.flatMap(row => (row.requested_host ? [row.requested_host] : [])),
    ),
  };
}

/**
 * Refunds 1 credit for a recorded Alexandria feedback row: at most once per
 * team, requested host, and UTC day, within ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS.
 * Never throws; a failed refund leaves the feedback recorded with 0 credits.
 */
export async function refundAlexandriaFeedback(params: {
  feedbackId: string;
  teamId: string;
  orgId: string | null;
  rating: FeedbackRating;
  requestedUrl: string;
  now?: Date;
}): Promise<AlexandriaRefundResult> {
  const { feedbackId, teamId, orgId, rating } = params;
  const now = params.now ?? new Date();
  const dailyRefundCap = config.ALEXANDRIA_FEEDBACK_DAILY_CAP_CREDITS;
  const host = new URL(params.requestedUrl).hostname.toLowerCase();
  const logger = _logger.child({
    module: "api/v2",
    method: "refundAlexandriaFeedback",
    feedbackId,
    teamId,
  });

  let refundedTodayBefore = 0;
  let outcome: RefundOutcome;
  if (!config.FEEDBACK_REFUND_ENABLED) {
    outcome = "refunds_disabled";
  } else {
    try {
      const today = await refundsToday(teamId, now);
      refundedTodayBefore = today.total;
      if (today.hosts.has(host)) outcome = "host_already_refunded_today";
      else if (refundedTodayBefore + REFUND_CREDITS > dailyRefundCap) {
        outcome = "daily_cap_reached";
      } else outcome = "alexandria_feedback";
    } catch (error) {
      logger.warn("Failed to read Alexandria feedback refunds; no refund", {
        error,
      });
      outcome = "refund_totals_unavailable";
    }
  }

  let creditsRefunded = 0;
  if (outcome === "alexandria_feedback") {
    creditsRefunded = REFUND_CREDITS;
    if (!orgId) {
      logger.error("Feedback refund skipped: no org for the team");
    } else {
      // Keyed by host and day so concurrent submissions for one website
      // cannot both credit the team.
      await autumnService.refundCredits({
        teamId,
        orgId,
        value: REFUND_CREDITS,
        idempotencyKey: `fc:refund:alexandria-feedback:${teamId}:${now.toISOString().slice(0, 10)}:${host}`,
        featureId: CREDITS_FEATURE_ID,
        properties: {
          source: "feedback",
          endpoint: "alexandria",
          feedbackId,
          rating,
          refundPolicy: outcome,
        },
      });
    }
  }

  try {
    await db
      .update(schema.alexandria_feedback)
      .set({
        credits_refunded: creditsRefunded,
        refund_policy: policyFor(outcome),
      })
      .where(eq(schema.alexandria_feedback.id, feedbackId));
  } catch (error) {
    logger.warn("Failed to persist Alexandria feedback refund details", {
      error,
      creditsRefunded,
    });
  }

  const creditsRefundedToday = refundedTodayBefore + creditsRefunded;
  const dailyCapReached =
    outcome === "daily_cap_reached" ||
    (dailyRefundCap > 0 && creditsRefundedToday >= dailyRefundCap);
  logger.info("Alexandria feedback refund processed", {
    creditsRefunded,
    refundPolicy: outcome,
    creditsRefundedToday,
    dailyRefundCap,
  });

  return {
    creditsRefunded,
    creditsRefundedToday,
    dailyRefundCap,
    ...(outcome === "host_already_refunded_today"
      ? {
          alreadySubmitted: true,
          warning: `Alexandria feedback for ${host} was already refunded today (UTC). Feedback was recorded; no additional refund issued.`,
        }
      : dailyCapReached
        ? {
            dailyCapReached: true,
            warning: `Daily Alexandria feedback refund cap of ${dailyRefundCap} credits reached for this team (UTC day). Feedback was recorded; further Alexandria feedback today will not refund credits.`,
          }
        : {}),
  };
}
