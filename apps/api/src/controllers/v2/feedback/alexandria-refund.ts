import { and, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";
import { config } from "../../../config";
import { db } from "../../../db/connection";
import * as schema from "../../../db/schema";
import { logger as _logger } from "../../../lib/logger";
import {
  autumnService,
  CREDITS_FEATURE_ID,
} from "../../../services/autumn/autumn.service";
import type { AlexandriaCall } from "../../../lib/alexandria-activity";
import type { FeedbackRating, RefundPolicySnapshot } from "./internal-types";

const REFUND_CREDITS = 1;
const REFUNDABLE_RATINGS: FeedbackRating[] = ["good", "partial", "bad"];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RefundOutcome =
  | "alexandria_feedback"
  | "refunds_disabled"
  | "refund_totals_unavailable"
  | "calls_already_refunded"
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
  message: string;
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
 * Whether earlier refunded feedback about the same website already covered
 * every call of this one. Feedback that names no call is never covered.
 */
async function callsAlreadyRefunded(
  tx: Tx,
  params: {
    feedbackId: string;
    teamId: string;
    host: string;
    calls: AlexandriaCall[];
  },
): Promise<boolean> {
  const { feedbackId, teamId, host, calls } = params;
  if (calls.length === 0) return false;
  const rows = await tx
    .select({
      request_id: schema.alexandria_feedback_calls.request_id,
      provider: schema.alexandria_feedback_calls.provider,
      capability: schema.alexandria_feedback_calls.capability,
    })
    .from(schema.alexandria_feedback_calls)
    .innerJoin(
      schema.alexandria_feedback,
      eq(
        schema.alexandria_feedback.id,
        schema.alexandria_feedback_calls.feedback_id,
      ),
    )
    .where(
      and(
        eq(schema.alexandria_feedback_calls.team_id, teamId),
        inArray(schema.alexandria_feedback_calls.request_id, [
          ...new Set(calls.map(call => call.requestId)),
        ]),
        ne(schema.alexandria_feedback_calls.feedback_id, feedbackId),
        eq(schema.alexandria_feedback.requested_host, host),
        gt(schema.alexandria_feedback.credits_refunded, 0),
      ),
    );
  const refunded = new Set(
    rows.map(row =>
      JSON.stringify([row.request_id, row.provider, row.capability]),
    ),
  );
  return calls.every(call =>
    refunded.has(
      JSON.stringify([call.requestId, call.provider, call.capability]),
    ),
  );
}

/**
 * Decides the refund and, when it is granted, reserves it on the feedback row.
 * The per-team lock serializes concurrent submissions so both daily caps hold.
 */
async function reserveRefund(params: {
  feedbackId: string;
  teamId: string;
  host: string;
  calls: AlexandriaCall[];
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
    const outcome: RefundOutcome = (await callsAlreadyRefunded(tx, params))
      ? "calls_already_refunded"
      : today.total + REFUND_CREDITS > dailyRefundCap
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
 * Refunds 1 credit for a recorded Alexandria feedback row, once per call and
 * website, within the team's daily cap and the per-website daily cap (both per
 * UTC day). Reports a refund only when billing confirms it. Never throws.
 */
export async function refundAlexandriaFeedback(params: {
  feedbackId: string;
  teamId: string;
  orgId: string | null;
  rating: FeedbackRating;
  requestedUrl: string;
  /** The calls the feedback row covers. */
  calls: AlexandriaCall[];
  now?: Date;
}): Promise<AlexandriaRefundResult> {
  const { feedbackId, teamId, orgId, rating, calls } = params;
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
          calls,
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
        // An unconfirmed refund frees its cap reservation below, so a late
        // durable retry landing would credit outside both daily caps.
        durableRetry: false,
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

  const noRefund: Record<RefundOutcome, string> = {
    alexandria_feedback: "",
    refunds_disabled: "feedback refunds are turned off",
    refund_totals_unavailable: "the refund could not be confirmed",
    refund_not_confirmed: "the refund could not be confirmed",
    calls_already_refunded:
      "earlier feedback about this website already refunded these Alexandria calls",
    website_cap_reached: `${host} reached its daily cap of ${websiteRefundCap} refunded credits`,
    daily_cap_reached: `the team reached its daily cap of ${dailyRefundCap} refunded credits`,
  };
  return {
    message:
      creditsRefunded > 0
        ? "Feedback recorded. 1 credit refunded."
        : `Feedback recorded. No refund: ${noRefund[outcome]}.`,
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
