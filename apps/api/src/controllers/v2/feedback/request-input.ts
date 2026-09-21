import { EndpointFeedbackRequest, SearchFeedbackRequest } from "../types";
import { FeedbackInput } from "./internal-types";

type RecordableEndpointFeedbackRequest = Extract<
  EndpointFeedbackRequest,
  { rating: "good" | "bad" | "partial" }
>;

export function toFeedbackInput(
  body: RecordableEndpointFeedbackRequest | SearchFeedbackRequest,
): FeedbackInput {
  return {
    rating: body.rating,
    ...("valuableSources" in body
      ? { valuableSources: body.valuableSources }
      : {}),
    ...("missingContent" in body
      ? { missingContent: body.missingContent }
      : {}),
    ...("querySuggestions" in body
      ? { querySuggestions: body.querySuggestions }
      : {}),
    origin: body.origin,
    integration: body.integration,
    ...("issues" in body ? { issues: body.issues } : {}),
    ...("tags" in body ? { tags: body.tags } : {}),
    ...("note" in body ? { note: body.note } : {}),
    ...("url" in body ? { url: body.url } : {}),
    ...("pageNumbers" in body ? { pageNumbers: body.pageNumbers } : {}),
    ...("metadata" in body ? { metadata: body.metadata } : {}),
  };
}

export function toSearchFeedbackInput(
  body: SearchFeedbackRequest,
): FeedbackInput {
  return toFeedbackInput(body);
}
