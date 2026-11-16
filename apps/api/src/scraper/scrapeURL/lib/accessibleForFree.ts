import { load } from "cheerio";

function isFalse(value: unknown): boolean {
  return (
    value === false ||
    (typeof value === "string" && value.trim().toLowerCase() === "false")
  );
}

function containsPaywallMarker(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "isAccessibleForFree" && isFalse(value)) return true;
      stack.push(value);
    }
  }
  return false;
}

/**
 * True when any JSON-LD block in the HTML declares schema.org
 * isAccessibleForFree as false (boolean or string, any case), at any depth
 * including @graph. Malformed blocks are skipped.
 */
export function isPaywalledByJsonLd(html: string | undefined): boolean {
  if (!html || !/ld\+json/i.test(html)) return false;

  const $ = load(html);
  return $('script[type="application/ld+json" i]')
    .toArray()
    .some(el => {
      let parsed: unknown;
      try {
        parsed = JSON.parse($(el).text());
      } catch {
        return false;
      }
      return containsPaywallMarker(parsed);
    });
}
