import { config } from "../../../config";
import { SEARCH_CREDITS_FEATURE_ID } from "../../../services/autumn/autumn.service";
import type { EndpointFeedbackEndpoint } from "../types";
import type { FeedbackInput, FeedbackRecordOptions } from "./internal-types";

type SearchFeedbackRecordOptionsParams = {
  jobId: string;
  feedback: FeedbackInput;
};

type EndpointFeedbackRecordOptionsParams = {
  endpoint: EndpointFeedbackEndpoint;
  jobId: string;
  feedback: FeedbackInput;
};

export function searchFeedbackRecordOptions({
  jobId,
  feedback,
}: SearchFeedbackRecordOptionsParams): FeedbackRecordOptions {
  return {
    endpoint: "search",
    jobId,
    feedback,
    requireSuccessfulJob: true,
    notFoundCode: "SEARCH_NOT_FOUND",
    failedJobCode: "SEARCH_FAILED",
    dbDisabledMessage:
      "Search feedback requires database authentication and is unavailable on this deployment.",
    windowExpiredMessage: `Search feedback must be submitted within ${config.SEARCH_FEEDBACK_MAX_AGE_SEC} seconds of the search.`,
    maxAgeSec: config.SEARCH_FEEDBACK_MAX_AGE_SEC,
    dailyCapCredits: config.SEARCH_FEEDBACK_DAILY_CAP_CREDITS,
    refundFeatureId: SEARCH_CREDITS_FEATURE_ID,
    source: "search_feedback",
  };
}

export function endpointFeedbackRecordOptions({
  endpoint,
  jobId,
  feedback,
}: EndpointFeedbackRecordOptionsParams): FeedbackRecordOptions {
  if (endpoint === "search") {
    return searchFeedbackRecordOptions({ jobId, feedback });
  }

  return {
    endpoint,
    jobId,
    feedback,
    source: "feedback",
  };
}
