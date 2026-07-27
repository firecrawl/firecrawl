// Site-declared brand marks (JSON-LD logo, apple-touch icon), collected for
// the server-side declared-logo fallback.

// Entity types whose `logo` is NOT the site's own brand mark: product/brand
// nodes carry the manufacturer's logo on retailer pages, person nodes carry
// avatars, review/rating nodes carry third parties. A denylist (rather than
// an Organization/WebSite allowlist) keeps coverage of schema.org's hundreds
// of LocalBusiness subtypes (Restaurant, Dentist, ...), which small-business
// sites commonly use. Substring family match so schema.org subtypes are
// covered without enumerating the type tree: "product" catches Product,
// ProductModel, IndividualProduct, ProductGroup, SomeProducts; "offer"
// catches Offer, AggregateOffer; "review"/"rating" catch their
// Aggregate/User variants. No Organization/WebSite/LocalBusiness-family type
// name contains any of these words, so legitimate site entities are
// unaffected.
const WRONG_ENTITY_TYPE = /product|offer|brand|review|rating|person|comment/i;

function typeAllowsSiteLogo(t: unknown): boolean {
  const types = Array.isArray(t) ? t : t == null ? [] : [t];
  return !types.some(
    x => typeof x === "string" && WRONG_ENTITY_TYPE.test(x.trim()),
  );
}

function isAllowedImageUrl(href: string): boolean {
  return /^https?:\/\//i.test(href) || /^data:image\//i.test(href);
}

function resolveLogoUrl(logo: unknown, baseUrl: string): string | null {
  let candidates: unknown[] = [];
  if (typeof logo === "string") {
    candidates = [logo];
  } else if (logo && typeof logo === "object" && !Array.isArray(logo)) {
    const img = logo as Record<string, unknown>;
    // ImageObject: contentUrl is the actual media bytes; url is inherited
    // Thing.url and may point at a page *about* the image, so it's tried
    // second. A candidate that fails validation falls through to the next
    // rather than suppressing it.
    candidates = [img.contentUrl, img.url];
  }
  for (const raw of candidates) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return resolved.href;
      }
    } catch (_) {
      // Invalid URL — try the next candidate
    }
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
  // Skip the whole subtree of wrong-entity nodes: their children (brand
  // objects, offers, sellers) frequently omit @type, so walking into them
  // would leak a manufacturer/third-party logo via an untyped child.
  if (!typeAllowsSiteLogo(obj["@type"])) return null;
  const resolved = resolveLogoUrl(obj.logo, baseUrl);
  if (resolved) return resolved;
  for (const v of Object.values(obj)) {
    const r = findLogo(v, depth + 1, baseUrl);
    if (r) return r;
  }
  return null;
}

/**
 * Site-declared logo from JSON-LD structured data (Organization / WebSite /
 * LocalBusiness-family entities). Relative URLs are resolved against the
 * page URL; wrong-entity subtrees (products, third-party brands, people,
 * reviews) are skipped entirely.
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

/**
 * Largest apple-touch icon (square brand mark by platform convention).
 * `sizes` may declare multiple tokens ("57x57 114x114") — the largest
 * dimension across all tokens wins. Only http(s)/data:image URLs qualify.
 */
export function findLargestAppleTouchIcon(doc: Document): string | null {
  let best: { href: string; size: number } | null = null;
  doc.querySelectorAll('link[rel*="apple-touch-icon" i]').forEach(el => {
    const link = el as HTMLLinkElement;
    if (!link.href || !isAllowedImageUrl(link.href)) return;
    const tokens = (link.getAttribute("sizes") || "").match(/\d+x\d+/gi) || [];
    let size = 1;
    for (const t of tokens) {
      const dim = Math.max(...t.toLowerCase().split("x").map(Number));
      if (dim > size) size = dim;
    }
    if (!best || size > best.size) {
      best = { href: link.href, size };
    }
  });
  return best ? (best as { href: string }).href : null;
}
