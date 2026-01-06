import { Document as V2Document } from "../controllers/v2/types";
import { Document as V1Document } from "../controllers/v1/types";

type DocumentMetadata = V1Document["metadata"] | V2Document["metadata"];

function sanitizeMetadataForResponse(
  metadata: DocumentMetadata,
): DocumentMetadata {
  if (!metadata) {
    return metadata;
  }
  const sanitized = { ...metadata };
  delete sanitized["sentry-trace"];
  delete sanitized["baggage"];
  return sanitized;
}

export function sanitizeDocumentForResponse(
  document: V1Document | V2Document,
): V1Document | V2Document {
  if (!document.metadata) {
    return document;
  }

  return {
    ...document,
    metadata: sanitizeMetadataForResponse(document.metadata),
  };
}
