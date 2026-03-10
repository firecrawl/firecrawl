import { Document } from "../../../controllers/v1/types";

/** Flatten newlines and strip control characters from a metadata value. */
function sanitizeMetadataValue(value: string, maxLen: number): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, maxLen);
}

export function buildDocument_F0(document: Document): string {
  const metadata = document.metadata;
  const markdown = document.markdown;

  // For each key in the metadata, sanitize and cap length
  const metadataString = Object.entries(metadata)
    .map(([key, value]) => {
      return `${key}: ${sanitizeMetadataValue(value?.toString() ?? "", 250)}`;
    })
    .join("\n");

  const documentMetadataString = `\n- - - - - Page metadata - - - - -\n${metadataString}`;
  const documentString = `${markdown}${documentMetadataString}`;
  return documentString;
}
