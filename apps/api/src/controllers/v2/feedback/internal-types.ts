import { logger as _logger } from "../../../lib/logger";
import type { SearchResultType } from "../../../lib/entities";
import {
  EndpointFeedbackEndpoint,
  EndpointFeedbackErrorCode,
  EndpointFeedbackResponse,
  SearchFeedbackErrorCode,
} from "../types";

export type FeedbackRating = "good" | "partial" | "bad";

/** A valuable result addressed by its group and 1-indexed position in it. */
export type ValuableResultInput = {
  source: SearchResultType;
  position: number;
  reason?: string;
};

export type FeedbackInput = {
  rating: FeedbackRating;
  issues?: string[];
  tags?: string[];
  note?: string;
  valuableSources?: Array<{ url: string; reason?: string }>;
  valuableResults?: ValuableResultInput[];
  missingContent?: Array<{ topic: string; description?: string }>;
  querySuggestions?: string;
  url?: string;
  pageNumbers?: number[];
  metadata?: Record<string, unknown>;
  origin?: string;
  integration?: string | null;
};

export type FeedbackJobRow = {
  endpoint: EndpointFeedbackEndpoint;
  id: string;
  request_id: string | null;
  team_id: string;
  credits_cost: number | null;
  created_at: string;
  is_successful: boolean | null;
  options: unknown;
  /** Total results returned by the job (search only; combined across web/news/images). */
  num_results?: number | null;
  /**
   * Per-source result counts (search only), e.g. `{"web":3,"images":0}`. Null on
   * rows written before the column existed, and on searches logged by v0/v1.
   */
  num_results_by_source?: unknown;
};

export type FeedbackRecordOptions = {
  endpoint: EndpointFeedbackEndpoint;
  jobId: string;
  feedback: FeedbackInput;
  requireSuccessfulJob?: boolean;
  notFoundCode?: EndpointFeedbackErrorCode | SearchFeedbackErrorCode;
  failedJobCode?: SearchFeedbackErrorCode;
  dbDisabledMessage?: string;
  windowExpiredMessage?: string;
  maxAgeSec?: number;
  dailyCapCredits?: number;
  refundFeatureId?: string;
  skipZdrPersistence?: boolean;
  source: "feedback" | "search_feedback";
};

export type FeedbackRecordResult = {
  status: number;
  body: EndpointFeedbackResponse | any;
};

export type RefundPolicySnapshot = {
  version: "feedback_refund_v1";
  enabled: boolean;
  endpoint: EndpointFeedbackEndpoint;
  mode: "none" | "flat" | "percentage_with_cap";
  refundableRatings: FeedbackRating[];
  matchedReason: string;
  flatCredits?: number;
  percent?: number;
  maxCredits?: number;
};

export type FeedbackLogger = ReturnType<typeof _logger.child>;
