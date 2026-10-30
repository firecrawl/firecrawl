// Meta tag names whose content can carry a noindex directive for us. The
// native extractor keys metadata by the raw tag name, while the cheerio
// fallback also fills firecrawlAgentRobots, so match names case-insensitively.
const NOINDEX_META_NAMES = new Set([
  "robots",
  "firecrawlagent",
  "firecrawlagentrobots",
]);

function contentValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

// Returns true when any robots or FirecrawlAgent meta tag contains noindex.
// Values may be a string or, when a page repeats the tag, an array of strings.
export function hasNoindexDirective(
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata) return false;
  for (const [key, value] of Object.entries(metadata)) {
    if (!NOINDEX_META_NAMES.has(key.toLowerCase())) continue;
    for (const content of contentValues(value)) {
      if (content.toLowerCase().includes("noindex")) return true;
    }
  }
  return false;
}
