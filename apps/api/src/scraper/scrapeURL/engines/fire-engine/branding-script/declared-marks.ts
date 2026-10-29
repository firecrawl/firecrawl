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

type IdMap = Map<string, Record<string, unknown>>;

function validateUrl(raw: unknown, baseUrl: string): string | null {
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

function resolveLogoUrl(
  logo: unknown,
  baseUrl: string,
  idMap: IdMap,
  depth = 0,
): string | null {
  if (depth > 3) return null;
  // Array-valued logo (legal JSON-LD): first item that resolves wins.
  if (Array.isArray(logo)) {
    for (const item of logo) {
      const r = resolveLogoUrl(item, baseUrl, idMap, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof logo === "string") {
    return validateUrl(logo, baseUrl);
  }
  if (logo && typeof logo === "object") {
    const img = logo as Record<string, unknown>;
    // ImageObject: contentUrl is the actual media bytes; url is inherited
    // Thing.url and may point at a page *about* the image, so it's tried
    // second. A candidate that fails validation falls through to the next
    // rather than suppressing it.
    const direct =
      validateUrl(img.contentUrl, baseUrl) ?? validateUrl(img.url, baseUrl);
    if (direct) return direct;
    // Node reference ({"@id": ...}) — the Yoast/WordPress @graph pattern:
    // the Organization's logo points at a separate ImageObject node carrying
    // the actual URL. Dereference it. A fragment @id ("...#/schema/logo/...")
    // names a node, never an image, so it's only usable via dereference.
    const id = img["@id"];
    if (typeof id === "string" && id.trim()) {
      const referenced = idMap.get(normalizeId(id, baseUrl));
      // The referenced node must itself pass the wrong-entity filter — a
      // logo reference into e.g. a Brand node must not leak that entity's
      // URL past the type check.
      if (
        referenced &&
        referenced !== logo &&
        typeAllowsSiteLogo(referenced["@type"])
      ) {
        const deref =
          validateUrl(referenced.contentUrl, baseUrl) ??
          validateUrl(referenced.url, baseUrl);
        if (deref) return deref;
      }
      if (!id.includes("#")) {
        return validateUrl(id, baseUrl);
      }
    }
  }
  return null;
}

// JSON-LD keyword properties must not be walked for entity content:
// an inline @context can define a "logo" *term* (e.g. mapping to
// https://schema.org/logo) which is vocabulary, not data. @graph and
// @included are the keywords that legitimately contain node objects.
function isWalkableKey(key: string): boolean {
  return !key.startsWith("@") || key === "@graph" || key === "@included";
}

// Reference and definition may spell the same @id differently (relative
// "/#logo" vs absolute "https://site.com/#logo") — index and look up by the
// resolved form.
function normalizeId(id: string, baseUrl: string): string {
  try {
    return new URL(id, baseUrl).href;
  } catch (_) {
    return id;
  }
}

// Uses the same validation as dereferencing: a definition whose URLs are
// unusable (empty, ipfs://, malformed) must not win the index slot over a
// later definition that dereferencing could actually use.
function hasUsableImageUrl(
  obj: Record<string, unknown>,
  baseUrl: string,
): boolean {
  return (
    validateUrl(obj.contentUrl, baseUrl) !== null ||
    validateUrl(obj.url, baseUrl) !== null
  );
}

function collectIds(
  node: unknown,
  depth: number,
  idMap: IdMap,
  baseUrl: string,
): void {
  if (!node || typeof node !== "object" || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) collectIds(item, depth + 1, idMap, baseUrl);
    return;
  }
  const obj = node as Record<string, unknown>;
  const id = obj["@id"];
  // Register only node *definitions* — a bare {"@id": ...} is a reference
  // stub, and indexing it would shadow the real node it points to. When the
  // same @id is defined more than once (split definitions), prefer the one
  // that actually carries an image URL.
  if (typeof id === "string" && id.trim() && Object.keys(obj).length > 1) {
    const key = normalizeId(id, baseUrl);
    const existing = idMap.get(key);
    if (
      !existing ||
      (!hasUsableImageUrl(existing, baseUrl) && hasUsableImageUrl(obj, baseUrl))
    ) {
      idMap.set(key, obj);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (isWalkableKey(k)) collectIds(v, depth + 1, idMap, baseUrl);
  }
}

function findLogo(
  node: unknown,
  depth: number,
  baseUrl: string,
  idMap: IdMap,
): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findLogo(item, depth + 1, baseUrl, idMap);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  // Skip the whole subtree of wrong-entity nodes: their children (brand
  // objects, offers, sellers) frequently omit @type, so walking into them
  // would leak a manufacturer/third-party logo via an untyped child.
  if (!typeAllowsSiteLogo(obj["@type"])) return null;
  const resolved = resolveLogoUrl(obj.logo, baseUrl, idMap);
  if (resolved) return resolved;
  for (const [k, v] of Object.entries(obj)) {
    if (!isWalkableKey(k)) continue;
    const r = findLogo(v, depth + 1, baseUrl, idMap);
    if (r) return r;
  }
  return null;
}

/**
 * Site-declared logo from JSON-LD structured data (Organization / WebSite /
 * LocalBusiness-family entities). Relative URLs are resolved against the
 * page URL; wrong-entity subtrees (products, third-party brands, people,
 * reviews) are skipped entirely; @id node references are dereferenced
 * across all JSON-LD blocks on the page (the Yoast @graph pattern).
 */
export function findDeclaredJsonLdLogo(doc: Document): string | null {
  const baseUrl = doc.location ? doc.location.href : "";
  const roots: unknown[] = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
    try {
      roots.push(JSON.parse(el.textContent || ""));
    } catch (_) {
      // Malformed JSON-LD — ignore
    }
  });
  // Pass 1: index @id → node across every block, so references resolve even
  // when the ImageObject lives in a different script tag than the Organization.
  const idMap: IdMap = new Map();
  for (const root of roots) collectIds(root, 0, idMap, baseUrl);
  // Pass 2: find the first usable declared logo.
  for (const root of roots) {
    const r = findLogo(root, 0, baseUrl, idMap);
    if (r) return r;
  }
  return null;
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
