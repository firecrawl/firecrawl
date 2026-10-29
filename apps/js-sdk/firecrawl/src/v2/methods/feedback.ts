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

export async function feedback(
  http: HttpClient,
  request: EndpointFeedbackRequest,
): Promise<FeedbackResponse> {
  if (!request.endpoint) throw new Error("endpoint is required");
  if (!request.jobId) throw new Error("jobId is required");
  validateRating(request.rating);

  try {
    const res = await http.post<FeedbackResponse>("/v2/feedback", request);
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
      `/v2/search/${encodeURIComponent(jobId)}/feedback`,
      request,
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
