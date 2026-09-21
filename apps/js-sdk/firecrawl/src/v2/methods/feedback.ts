import {
  type EndpointFeedbackRequest,
  type FeedbackResponse,
  type SearchFeedbackRequest,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import {
  normalizeAxiosError,
  throwForBadResponse,
} from "../utils/errorHandler";

function validateRating(rating: string): void {
  if (!["good", "partial", "bad"].includes(rating)) {
    throw new Error("rating must be one of: good, partial, bad");
  }
}

type TargetedFeedbackRequest = Exclude<
  EndpointFeedbackRequest,
  { endpoint: unknown }
>;
type FirecrawlJobFeedbackRequest = Extract<
  TargetedFeedbackRequest,
  { target: { type: "firecrawl_job" } }
>;
type AlexandriaResultFeedbackRequest = Extract<
  TargetedFeedbackRequest,
  { target: { type: "alexandria_result" } }
>;

function isFirecrawlJobFeedback(
  request: TargetedFeedbackRequest,
): request is FirecrawlJobFeedbackRequest {
  return request.target.type === "firecrawl_job";
}

function isAlexandriaResultFeedback(
  request: TargetedFeedbackRequest,
): request is AlexandriaResultFeedbackRequest {
  return request.target.type === "alexandria_result";
}

export async function feedback(
  http: HttpClient,
  request: EndpointFeedbackRequest,
): Promise<FeedbackResponse> {
  if ("endpoint" in request) {
    if (!request.endpoint) throw new Error("endpoint is required");
    if (!request.jobId) throw new Error("jobId is required");
    validateRating(request.rating);
  } else if (isFirecrawlJobFeedback(request)) {
    if (!request.target.endpoint) throw new Error("target.endpoint is required");
    if (!request.target.jobId) throw new Error("target.jobId is required");
    validateRating(request.rating);
  } else if (isAlexandriaResultFeedback(request)) {
    if (!request.target.feedbackRef)
      throw new Error("target.feedbackRef is required");
    validateRating(request.rating);
  } else if (!request.request.need) {
    throw new Error("request.need is required");
  }

  try {
    const res = await http.post<FeedbackResponse>(
      "/v2/feedback",
      request as unknown as Record<string, unknown>,
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "feedback");
    }
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "feedback");
    throw err;
  }
}

export async function searchFeedback(
  http: HttpClient,
  jobId: string,
  request: SearchFeedbackRequest,
): Promise<FeedbackResponse> {
  if (!jobId) throw new Error("jobId is required");
  validateRating(request.rating);

  try {
    const res = await http.post<FeedbackResponse>(
      "/v2/feedback",
      {
        target: { type: "firecrawl_job", endpoint: "search", jobId },
        ...request,
      },
    );
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "searchFeedback");
    }
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "searchFeedback");
    throw err;
  }
}
