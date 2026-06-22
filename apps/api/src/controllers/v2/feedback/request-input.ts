import { EndpointFeedbackRequest, SearchFeedbackRequest } from "../types";
import { FeedbackInput } from "./internal-types";

export function toFeedbackInput(
  body: EndpointFeedbackRequest | SearchFeedbackRequest,
): FeedbackInput {
  return {
    rating: body.rating,
    valuableSources: body.valuableSources,
    missingContent: body.missingContent,
    querySuggestions: body.querySuggestions,
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
