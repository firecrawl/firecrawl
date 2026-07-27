// Entity types whose `logo` is NOT the site's own brand mark: product/brand
// nodes carry the manufacturer's logo on retailer pages, person nodes carry
// avatars, review/rating nodes carry third parties. A denylist (rather than
// an Organization/WebSite allowlist) keeps coverage of schema.org's hundreds
// of LocalBusiness subtypes (Restaurant, Dentist, ...), which small-business
// sites commonly use.
const WRONG_ENTITY_TYPE =
  /^(brand|product|productgroup|offer|review|rating|aggregaterating|person|comment)$/i;

function typeAllowsSiteLogo(t: unknown): boolean {
  const types = Array.isArray(t) ? t : t == null ? [] : [t];
  return !types.some(
    x => typeof x === "string" && WRONG_ENTITY_TYPE.test(x.trim()),
  );
}

function resolveLogoUrl(logo: unknown, baseUrl: string): string | null {
  const raw =
    typeof logo === "string"
      ? logo
      : logo && typeof logo === "object" && !Array.isArray(logo)
        ? (logo as Record<string, unknown>).url
        : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return resolved.href;
    }
  } catch (_) {
    // Invalid URL — ignore
  }
  return null;
}

function findLogo(
  node: unknown,
  depth: number,
  baseUrl: string,
): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findLogo(item, depth + 1, baseUrl);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (typeAllowsSiteLogo(obj["@type"])) {
    const resolved = resolveLogoUrl(obj.logo, baseUrl);
    if (resolved) return resolved;
  }
  for (const v of Object.values(obj)) {
    const r = findLogo(v, depth + 1, baseUrl);
    if (r) return r;
  }
  return null;
}

/**
 * Site-declared logo from JSON-LD structured data (Organization / WebSite /
 * LocalBusiness-family entities). Relative URLs are resolved against the
 * page URL; entities whose `logo` describes something other than the site's
 * brand (products, third-party brands, people, reviews) are skipped.
 */
export function findDeclaredJsonLdLogo(doc: Document): string | null {
  let declared: string | null = null;
  const baseUrl = doc.location ? doc.location.href : "";
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
    if (declared) return;
    try {
      declared = findLogo(JSON.parse(el.textContent || ""), 0, baseUrl);
    } catch (_) {
      // Malformed JSON-LD — ignore
    }
  });
  return declared;
}
