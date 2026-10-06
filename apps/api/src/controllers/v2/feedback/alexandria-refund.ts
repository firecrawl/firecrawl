import { and, eq, gt, gte, sql } from "drizzle-orm";
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RefundOutcome =
  | "alexandria_feedback"
  | "refunds_disabled"
  | "refund_totals_unavailable"
  | "website_cap_reached"
  | "daily_cap_reached"
  | "refund_not_confirmed";

type AlexandriaRefundResult = {
  creditsRefunded: number;
  creditsRefundedToday: number;
  dailyRefundCap: number;
  dailyCapReached?: boolean;
  websiteCapReached?: boolean;
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

function refundWrite(feedbackId: string, outcome: RefundOutcome) {
  return {
    values: {
      credits_refunded: outcome === "alexandria_feedback" ? REFUND_CREDITS : 0,
      refund_policy: policyFor(outcome),
      updated_at: new Date().toISOString(),
    },
    where: eq(schema.alexandria_feedback.id, feedbackId),
  };
}

async function refundsToday(
  tx: Tx,
  teamId: string,
  now: Date,
): Promise<{ total: number; byHost: Map<string, number> }> {
  const rows = await tx
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
  let total = 0;
  const byHost = new Map<string, number>();
  for (const row of rows) {
    const credits = row.credits_refunded ?? 0;
    total += credits;
    if (row.requested_host) {
      byHost.set(
        row.requested_host,
        (byHost.get(row.requested_host) ?? 0) + credits,
      );
    }
  }
  return { total, byHost };
}

/**
 * Decides the refund and, when it is granted, reserves it on the feedback row.
 * The per-team lock serializes concurrent submissions so both daily caps hold.
 */
async function reserveRefund(params: {
  feedbackId: string;
  teamId: string;
  host: string;
  dailyRefundCap: number;
  websiteRefundCap: number;
  now: Date;
}): Promise<{
  outcome: RefundOutcome;
  refundedTodayBefore: number;
  websiteRefundedBefore: number;
}> {
  const { feedbackId, teamId, host, dailyRefundCap, websiteRefundCap, now } =
    params;
  return db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alexandria_feedback_refund:${teamId}`}, 0))`,
    );
    const today = await refundsToday(tx, teamId, now);
    const websiteRefundedBefore = today.byHost.get(host) ?? 0;
    const outcome: RefundOutcome =
      today.total + REFUND_CREDITS > dailyRefundCap
        ? "daily_cap_reached"
        : websiteRefundedBefore + REFUND_CREDITS > websiteRefundCap
          ? "website_cap_reached"
          : "alexandria_feedback";
    const write = refundWrite(feedbackId, outcome);
    await tx
      .update(schema.alexandria_feedback)
      .set(write.values)
      .where(write.where);
    return { outcome, refundedTodayBefore: today.total, websiteRefundedBefore };
  });
}

/**
 * Refunds 1 credit for a recorded Alexandria feedback row, within the team's
 * daily cap and the per-website daily cap (both per UTC day). Reports a refund
 * only when billing confirms it. Never throws.
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
  const websiteRefundCap = config.ALEXANDRIA_FEEDBACK_WEBSITE_DAILY_CAP_CREDITS;
  const host = new URL(params.requestedUrl).hostname.toLowerCase();
  const logger = _logger.child({
    module: "api/v2",
    method: "refundAlexandriaFeedback",
    feedbackId,
    teamId,
  });

  const persist = async (outcome: RefundOutcome) => {
    const write = refundWrite(feedbackId, outcome);
    try {
      await db
        .update(schema.alexandria_feedback)
        .set(write.values)
        .where(write.where);
    } catch (error) {
      logger.warn("Failed to persist Alexandria feedback refund details", {
        error,
        refundPolicy: outcome,
      });
    }
  };

  let outcome: RefundOutcome;
  let refundedTodayBefore = 0;
  let websiteRefundedBefore = 0;
  if (!config.FEEDBACK_REFUND_ENABLED) {
    outcome = "refunds_disabled";
    await persist(outcome);
  } else {
    try {
      ({ outcome, refundedTodayBefore, websiteRefundedBefore } =
        await reserveRefund({
          feedbackId,
          teamId,
          host,
          dailyRefundCap,
          websiteRefundCap,
          now,
        }));
    } catch (error) {
      logger.warn("Failed to reserve Alexandria feedback refund; no refund", {
        error,
      });
      outcome = "refund_totals_unavailable";
      await persist(outcome);
    }
  }

  if (outcome === "alexandria_feedback") {
    const confirmed =
      orgId !== null &&
      (await autumnService.refundCredits({
        teamId,
        orgId,
        value: REFUND_CREDITS,
        idempotencyKey: `fc:refund:alexandria-feedback:${feedbackId}`,
        featureId: CREDITS_FEATURE_ID,
        properties: {
          source: "feedback",
          endpoint: "alexandria",
          feedbackId,
          rating,
          refundPolicy: outcome,
        },
      }));
    if (!confirmed) {
      logger.warn("Alexandria feedback refund not confirmed by billing", {
        hasOrg: orgId !== null,
      });
      outcome = "refund_not_confirmed";
      await persist(outcome);
    }
  }

  const creditsRefunded =
    outcome === "alexandria_feedback" ? REFUND_CREDITS : 0;
  const creditsRefundedToday = refundedTodayBefore + creditsRefunded;
  const dailyCapReached =
    outcome === "daily_cap_reached" ||
    (dailyRefundCap > 0 && creditsRefundedToday >= dailyRefundCap);
  const websiteCapReached =
    outcome === "website_cap_reached" ||
    (websiteRefundCap > 0 &&
      websiteRefundedBefore + creditsRefunded >= websiteRefundCap);
  logger.info("Alexandria feedback refund processed", {
    creditsRefunded,
    refundPolicy: outcome,
    creditsRefundedToday,
    dailyRefundCap,
    websiteRefundCap,
  });

  return {
    creditsRefunded,
    creditsRefundedToday,
    dailyRefundCap,
    ...(dailyCapReached ? { dailyCapReached: true } : {}),
    ...(websiteCapReached ? { websiteCapReached: true } : {}),
    ...(dailyCapReached
      ? {
          warning: `Daily Alexandria feedback refund cap of ${dailyRefundCap} credits reached for this team (UTC day). Feedback was recorded; further Alexandria feedback today will not refund credits.`,
        }
      : websiteCapReached
        ? {
            warning: `Daily refund cap of ${websiteRefundCap} credits reached for Alexandria feedback about ${host} (UTC day). Feedback was recorded; further feedback about this website today will not refund credits.`,
          }
        : {}),
  };
}
