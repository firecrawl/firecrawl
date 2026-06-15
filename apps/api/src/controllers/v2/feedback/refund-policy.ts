import { config } from "../../../config";
import {
  FeedbackJobRow,
  FeedbackRating,
  RefundPolicySnapshot,
} from "./internal-types";

type RefundablePolicy =
  | {
      mode: "flat";
      reason: string;
      ratings: FeedbackRating[];
      credits: number;
    }
  | {
      mode: "percentage_with_cap";
      reason: string;
      ratings: FeedbackRating[];
      percent: number;
      maxCredits: number;
    };

function optionListIncludes(
  options: unknown,
  key: string,
  value: string,
): boolean {
  const list = (options as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) return false;

  return list.some(item => {
    if (item === value) return true;
    return (
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === value
    );
  });
}

function hasActions(options: unknown): boolean {
  const actions = (options as { actions?: unknown } | null)?.actions;
  return Array.isArray(actions) && actions.length > 0;
}

function none(
  job: FeedbackJobRow,
  matchedReason: string,
  refundableRatings: FeedbackRating[] = [],
): { desiredRefund: number; policy: RefundPolicySnapshot } {
  return {
    desiredRefund: 0,
    policy: {
      version: "feedback_refund_v1",
      enabled: config.FEEDBACK_REFUND_ENABLED,
      endpoint: job.endpoint,
      mode: "none",
      refundableRatings,
      matchedReason,
    },
  };
}

function policyFor(job: FeedbackJobRow): RefundablePolicy {
  switch (job.endpoint) {
    case "search":
      return {
        mode: "flat",
        reason: "search_feedback",
        ratings: ["good", "partial", "bad"],
        credits: 1,
      };
    case "map":
      return {
        mode: "flat",
        reason: "map_feedback",
        ratings: ["partial", "bad"],
        credits: 1,
      };
    case "parse":
      return {
        mode: "percentage_with_cap",
        reason: "parse_feedback",
        ratings: ["partial", "bad"],
        percent: 0.25,
        maxCredits: 10,
      };
    case "scrape":
      if (optionListIncludes(job.options, "parsers", "pdf")) {
        return {
          mode: "percentage_with_cap",
          reason: "scrape_pdf_feedback",
          ratings: ["partial", "bad"],
          percent: 0.25,
          maxCredits: 10,
        };
      }

      if (
        optionListIncludes(job.options, "formats", "json") ||
        optionListIncludes(job.options, "formats", "screenshot") ||
        hasActions(job.options)
      ) {
        return {
          mode: "percentage_with_cap",
          reason: optionListIncludes(job.options, "formats", "json")
            ? "scrape_json_feedback"
            : "scrape_addon_feedback",
          ratings: ["partial", "bad"],
          percent: 0.25,
          maxCredits: 5,
        };
      }

      return {
        mode: "flat",
        reason: "scrape_feedback",
        ratings: ["partial", "bad"],
        credits: 1,
      };
  }
}

export function computeRefundPolicy(
  job: FeedbackJobRow,
  rating: FeedbackRating,
): { desiredRefund: number; policy: RefundPolicySnapshot } {
  const billedCredits = Math.max(0, job.credits_cost ?? 0);
  if (!config.FEEDBACK_REFUND_ENABLED) return none(job, "refunds_disabled");
  if (billedCredits <= 0) return none(job, "zero_billed_credits");

  const policy = policyFor(job);
  if (!policy.ratings.includes(rating)) {
    return none(job, "rating_not_refundable", policy.ratings);
  }

  if (policy.mode === "flat") {
    return {
      desiredRefund: Math.min(policy.credits, billedCredits),
      policy: {
        version: "feedback_refund_v1",
        enabled: true,
        endpoint: job.endpoint,
        mode: "flat",
        refundableRatings: policy.ratings,
        matchedReason: policy.reason,
        flatCredits: policy.credits,
        maxCredits: policy.credits,
      },
    };
  }

  return {
    desiredRefund: Math.min(
      Math.ceil(billedCredits * policy.percent),
      policy.maxCredits,
      billedCredits,
    ),
    policy: {
      version: "feedback_refund_v1",
      enabled: true,
      endpoint: job.endpoint,
      mode: "percentage_with_cap",
      refundableRatings: policy.ratings,
      matchedReason: policy.reason,
      percent: policy.percent,
      maxCredits: policy.maxCredits,
    },
  };
}
