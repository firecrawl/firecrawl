// Meta tag names whose content can carry a noindex directive for us. Both the
// native extractor and the cheerio fallback key metadata by the raw tag name
// and collect repeated tags into arrays, so match names case-insensitively.
const NOINDEX_META_NAMES = new Set(["robots", "firecrawlagent"]);

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
