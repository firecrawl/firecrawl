import { load } from "cheerio";

const MAX_DEPTH = 32;

function isFalse(value: unknown): boolean {
  return (
    value === false ||
    (typeof value === "string" && value.trim().toLowerCase() === "false")
  );
}

function containsPaywallMarker(node: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some(child => containsPaywallMarker(child, depth + 1));
  }

  return Object.entries(node).some(([key, value]) =>
    key === "isAccessibleForFree"
      ? isFalse(value) || containsPaywallMarker(value, depth + 1)
      : containsPaywallMarker(value, depth + 1),
  );
}

/**
 * True when any JSON-LD block in the HTML declares schema.org
 * isAccessibleForFree as false (boolean or string, any case), at any depth
 * including @graph. Malformed blocks are skipped.
 */
export function isPaywalledByJsonLd(html: string | undefined): boolean {
  if (!html || !/isAccessibleForFree/i.test(html)) return false;

  const $ = load(html);
  return $('script[type="application/ld+json" i]')
    .toArray()
    .some(el => {
      try {
        return containsPaywallMarker(JSON.parse($(el).text()), 0);
      } catch {
        return false;
      }
    });
}
