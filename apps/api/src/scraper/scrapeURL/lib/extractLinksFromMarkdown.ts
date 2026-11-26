import { extractLinksFromMarkdown as nativeExtractLinksFromMarkdown } from "@mendable/firecrawl-rs";

const MARKDOWN_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
];

/** Bodies served as text but authored as markdown, e.g. llms.txt. */
export function isMarkdownContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }
  // Media types are case-insensitive and may carry parameters ("; charset=").
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return MARKDOWN_CONTENT_TYPES.includes(mediaType);
}

/** Extracts links from a markdown or plaintext body, excluding images. */
export function extractLinksFromMarkdown(
  text: string,
  baseUrl: string,
): string[] {
  return nativeExtractLinksFromMarkdown(text, baseUrl);
}
