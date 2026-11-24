import {
  type AlexandriaFeedbackRequest,
  type AlexandriaFeedbackResponse,
  type EndpointFeedbackRequest,
  type FeedbackResponse,
  type SearchFeedbackRequest,
} from "../types";
import { HttpClient } from "../utils/httpClient";
import { ALEXANDRIA_FEEDBACK_MAX_TOKENS } from "../utils/feedbackTokens";
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

const ALEXANDRIA_FEEDBACK_MAX_TOKEN_LENGTH = 1024;

function validateToken(token: unknown, label: string): void {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > ALEXANDRIA_FEEDBACK_MAX_TOKEN_LENGTH
  ) {
    throw new Error(
      `${label} must be a string of 1 to ${ALEXANDRIA_FEEDBACK_MAX_TOKEN_LENGTH} characters`,
    );
  }
}

export async function alexandriaFeedback(
  http: HttpClient,
  request: AlexandriaFeedbackRequest,
): Promise<AlexandriaFeedbackResponse> {
  validateRating(request.rating);
  const { tokens, callRatings } = request;
  if (tokens != null) {
    if (!Array.isArray(tokens)) throw new Error("tokens must be an array");
    if (tokens.length > ALEXANDRIA_FEEDBACK_MAX_TOKENS) {
      throw new Error(
        `tokens accepts at most ${ALEXANDRIA_FEEDBACK_MAX_TOKENS} entries`,
      );
    }
    tokens.forEach((token, index) => validateToken(token, `tokens[${index}]`));
  }
  request.capabilityFeedback?.forEach((entry, index) => {
    if (
      entry?.issue === "new_capability_request" &&
      !entry.requestedFunctionality?.trim()
    ) {
      throw new Error(
        `capabilityFeedback[${index}].requestedFunctionality is required for new_capability_request`,
      );
    }
  });
  if (callRatings != null) {
    if (!Array.isArray(callRatings))
      throw new Error("callRatings must be an array");
    if (callRatings.length > ALEXANDRIA_FEEDBACK_MAX_TOKENS) {
      throw new Error(
        `callRatings accepts at most ${ALEXANDRIA_FEEDBACK_MAX_TOKENS} entries`,
      );
    }
    callRatings.forEach((entry, index) => {
      validateToken(entry?.token, `callRatings[${index}].token`);
      validateRating(entry.rating);
    });
  }

  try {
    const res = await http.post<AlexandriaFeedbackResponse>("/v2/feedback", {
      ...request,
      endpoint: "alexandria",
    });
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "alexandriaFeedback");
    }
    return res.data;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "alexandriaFeedback");
    throw err;
  }
}
