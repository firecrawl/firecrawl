import { load, type CheerioAPI, type Element } from "cheerio"; // rustified
import { logger } from "../../../lib/logger";
import type {
  ProductProfile,
  ProductPrice,
  ProductAvailability,
  ProductImage,
  ProductVariant,
} from "../../../types/product";

/**
 * Multi-source structured product extractor, ported from the product-search
 * Rust crate (`platforms::structured_data` / `platforms::structured_schema`).
 *
 * This file ships the JSON-LD, microdata, RDFa, embedded-state, runParams
 * (AliExpress), dataLayer (GA4), and OpenGraph sources, the canonical normalize
 * step, and the identity-aware per-field merge across all sources. The public
 * signature `extractProducts(html, baseUrl)` is STABLE and must not change.
 */

/**
 * Canonical field priority used by the (future) multi-source merge. Defined now
 * so later source parsers and the merge step share one ordering. Higher-priority
 * sources win per-field; this array fixes the field set + order we merge over.
 */
export const STRUCTURED_FIELDS = [
  "id",
  "sku",
  "title",
  "brand",
  "description",
  "url",
  "price",
  "originalPrice",
  "availability",
  "images",
  "category",
  "variants",
] as const;

/**
 * Internal intermediate shape produced by each source parser, mirroring the
 * Rust normalized object. `title` is the merge gate: a node without a title is
 * not a product. `url` defaults to the page URL only at finalize time.
 */
interface RawProduct {
  id?: string;
  sku?: string;
  title?: string;
  brand?: string;
  description?: string;
  url?: string;
  price?: ProductPrice;
  originalPrice?: ProductPrice;
  availability?: ProductAvailability;
  images?: ProductImage[];
  category?: string;
  variants?: ProductVariant[];
}

// ---------------------------------------------------------------------------
// schema.org type matching
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `is_product_schema_type`: strip any `/`, `#`, or `:` prefix
 * (e.g. `https://schema.org/Product` -> `product`) and match case-insensitively.
 */
function isProductSchemaType(value: string): boolean {
  const ty = value.split(/[/#:]/).pop()!.toLowerCase();
  return (
    ty === "product" ||
    ty === "productgroup" ||
    ty === "individualproduct" ||
    ty === "someproducts"
  );
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Number from a JSON number or numeric string (mirrors Rust `as_f64`). */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Mirrors Rust `find_product_node`: depth-first search for the first node whose
 * `@type` matches a product schema type, preferring `@graph` then `mainEntity`
 * then any nested value.
 */
function findProductNode(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const map = value as Record<string, unknown>;
    const type = map["@type"];
    let isProduct = false;
    if (Array.isArray(type)) {
      isProduct = type
        .map(asString)
        .filter((t): t is string => t !== undefined)
        .some(isProductSchemaType);
    } else {
      const t = asString(type);
      isProduct = t !== undefined && isProductSchemaType(t);
    }
    if (isProduct) {
      return map;
    }
    return (
      findProductNode(map["@graph"]) ??
      findProductNode(map["mainEntity"]) ??
      (() => {
        for (const v of Object.values(map)) {
          const found = findProductNode(v);
          if (found) return found;
        }
        return null;
      })()
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-LD source
// ---------------------------------------------------------------------------

/**
 * Scans `<script type="application/ld+json">` blocks, tolerating parse errors,
 * top-level arrays, and `@graph`, and returns the normalized first product.
 */
function parseJsonLd(html: string, baseUrl: string): RawProduct | null {
  const $ = load(html);
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = $(scripts[i]).text().trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Tolerate malformed JSON-LD blocks; move on to the next script.
      continue;
    }
    const node = findProductNode(parsed);
    if (node) {
      return normalizeStructuredProduct(node, baseUrl);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Microdata source
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `itemprop_value`: resolve a microdata property value with the
 * precedence `content` attribute -> `href`/`src` attribute -> trimmed inner
 * text. Returns undefined when nothing non-empty is found.
 */
function itempropValue($: CheerioAPI, el: Element): string | undefined {
  const node = $(el);
  const content = node.attr("content");
  if (content !== undefined && content.trim() !== "") return content.trim();
  const href = node.attr("href") ?? node.attr("src");
  if (href !== undefined && href.trim() !== "") return href.trim();
  const text = node.text().trim();
  return text !== "" ? text : undefined;
}

/**
 * Mirrors Rust `microdata_product_fragment` + `extract_microdata_structured`.
 *
 * Scopes to the SINGLE element whose `itemtype` ends in `schema.org/Product`
 * (tolerating http/https and a trailing slash). If zero or more than one such
 * Product scope exists, we fail closed (return null) rather than guess which
 * element is the page product.
 *
 * Within that scope we read direct itemprops only, excluding any nested inside a
 * deeper `[itemscope]` (which would belong to a sub-item, not this product). The
 * collected props are shaped like the JSON-LD node `normalizeStructuredProduct`
 * expects, so both sources share one normalize.
 */
function parseMicrodata(html: string, baseUrl: string): RawProduct | null {
  const $ = load(html);

  // schema.org/Product, tolerating http/https and a trailing slash.
  const scopes = $("[itemtype]").filter((_, el) => {
    const itemtype = $(el).attr("itemtype") ?? "";
    return /schema\.org\/Product\/?$/i.test(itemtype.trim());
  });
  if (scopes.length !== 1) return null; // zero or ambiguous -> fail closed
  const scope = scopes[0];

  // First itemprop value belonging directly to THIS product scope: skip any
  // itemprop whose closest ancestor `[itemscope]` is a deeper nested item.
  const propValue = (prop: string): string | undefined => {
    const matches = $(scope).find(`[itemprop~="${prop}"]`);
    for (let i = 0; i < matches.length; i++) {
      const el = matches[i];
      const owner = $(el).parent().closest("[itemscope]");
      if (owner.length && owner[0] !== scope) continue; // nested item -> skip
      const value = itempropValue($, el);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const node: Record<string, unknown> = { "@type": "Product" };
  for (const prop of [
    "name",
    "price",
    "priceCurrency",
    "availability",
    "brand",
    "description",
    "image",
    "sku",
    "category",
  ]) {
    const value = propValue(prop);
    if (value !== undefined) node[prop] = value;
  }

  // Same gate as Rust: ignore a scope with neither a name nor a price.
  if (node["name"] === undefined && node["price"] === undefined) return null;

  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// OpenGraph / <meta> source
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `meta_content`: read the `content` of the first `<meta>` whose
 * `property` matches the key, falling back to `name` (some publishers emit the
 * og/product keys on `name` rather than `property`, matching how
 * extractMetadata.ts tolerates both). Returns the trimmed value, or undefined
 * when absent/empty.
 */
function metaContent($: CheerioAPI, key: string): string | undefined {
  const value =
    $(`meta[property="${key}"]`).attr("content") ??
    $(`meta[name="${key}"]`).attr("content");
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed !== "" ? trimmed : undefined;
}

/**
 * Mirrors Rust `availability_token`: map the many ways stock state is expressed
 * (schema.org URLs, OpenGraph strings) onto the schema.org tokens the shared
 * normalizer already understands. Returns undefined for unrecognized text so we
 * omit availability rather than guess.
 */
function availabilityToken(raw: string): string | undefined {
  const tail = raw.split(/[/#]/).pop() ?? raw;
  const compact = tail.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  switch (compact) {
    case "instock":
    case "instoreonly":
    case "onlineonly":
    case "available":
    case "true":
      return "InStock";
    case "limitedavailability":
    case "limited":
    case "lowstock":
      return "LimitedAvailability";
    case "outofstock":
    case "soldout":
    case "oos":
    case "unavailable":
    case "false":
      return "OutOfStock";
    case "preorder":
      return "PreOrder";
    case "backorder":
      return "BackOrder";
    case "discontinued":
      return "Discontinued";
    default:
      return undefined;
  }
}

/**
 * Mirrors Rust `extract_opengraph_structured`. Reads product/OpenGraph `<meta>`
 * tags into the JSON-LD-shaped node `normalizeStructuredProduct` expects.
 *
 * CRITICAL fail-closed rule: the page is treated as a product ONLY when a price
 * meta (`product:price:amount` / `og:price:amount`) is present. `og:type=product`
 * alone is too weak — category/landing pages (e.g. apple.com/.../buy-mac) set it
 * too, which would mint hollow, price-less "products". No price -> return null.
 */
function parseOpenGraph(html: string, baseUrl: string): RawProduct | null {
  const $ = load(html);

  const priceText =
    metaContent($, "product:price:amount") ?? metaContent($, "og:price:amount");
  const price = asNumber(priceText);
  // OpenGraph is only trusted as a product source when it carries a price.
  if (price === undefined) return null;

  const currency =
    metaContent($, "product:price:currency") ??
    metaContent($, "og:price:currency");
  const availabilityRaw =
    metaContent($, "product:availability") ?? metaContent($, "og:availability");
  const availability =
    availabilityRaw !== undefined
      ? availabilityToken(availabilityRaw)
      : undefined;

  const offers: Record<string, unknown> = { price };
  if (currency !== undefined) offers["priceCurrency"] = currency;
  if (availability !== undefined) offers["availability"] = availability;

  const node: Record<string, unknown> = { "@type": "Product", offers };
  const name = metaContent($, "og:title");
  if (name !== undefined) node["name"] = name;
  const description = metaContent($, "og:description");
  if (description !== undefined) node["description"] = description;
  const image = metaContent($, "og:image");
  if (image !== undefined) node["image"] = image;
  const url = metaContent($, "og:url");
  if (url !== undefined) node["url"] = url;

  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// Embedded-state source (__NEXT_DATA__ / framework hydration blobs)
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `json_object_after`: finds the first brace-balanced `{...}`
 * object beginning at or after `anchor`, and `JSON.parse`s it as strict JSON.
 * Returns undefined when the anchor is absent or the object is not valid JSON
 * (fail closed — we do not attempt to repair JS object literals with single
 * quotes / unquoted keys).
 */
function jsonObjectAfter(
  haystack: string,
  anchor: string,
): Record<string, unknown> | undefined {
  const anchorIdx = haystack.indexOf(anchor);
  if (anchorIdx === -1) return undefined;
  const rest = haystack.slice(anchorIdx + anchor.length);
  const open = rest.indexOf("{");
  if (open === -1) return undefined;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = open; i < rest.length; i++) {
    const ch = rest[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(rest.slice(open, i + 1));
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Mirrors Rust `extract_embedded_state_json` + `extract_next_data_json`. Reads a
 * hydration/state JSON blob from the common SSR frameworks. First tries the
 * `<script id="__NEXT_DATA__" type="application/json">` block, then the
 * `window.__NUXT__ = {...}` / Apollo / Redux / Remix assignment object literals.
 * Returns the first one that parses as a JSON object; tolerates parse failures.
 */
function extractEmbeddedStateJson(
  html: string,
): Record<string, unknown> | undefined {
  const $ = load(html);
  const nextData = $('script#__NEXT_DATA__[type="application/json"]')
    .first()
    .text()
    .trim();
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Tolerate a malformed __NEXT_DATA__ blob; fall through to anchors.
    }
  }
  for (const anchor of [
    "window.__NUXT__",
    "window.__APOLLO_STATE__",
    "window.__INITIAL_STATE__",
    "window.__PRELOADED_STATE__",
    "window.__remixContext",
  ]) {
    const obj = jsonObjectAfter(html, anchor);
    if (obj !== undefined) return obj;
  }
  return undefined;
}

/**
 * Mirrors Rust `is_product_like`: a node looks like a concrete product when it
 * has a name/title string AND a real, parseable price (`price` or the first
 * `offers` entry's `price`). A bare `priceCurrency` is deliberately NOT enough —
 * locale/config nodes commonly carry a currency without being products.
 */
function isProductLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  const hasName =
    asString(node["name"]) !== undefined ||
    asString(node["title"]) !== undefined;
  const hasPrice =
    asNumber(node["price"]) !== undefined ||
    asNumber(firstOffer(node)?.["price"]) !== undefined;
  return hasName && hasPrice;
}

/**
 * Mirrors Rust `next_data_known_product`: looks up the product at well-known
 * Next.js page-product paths. A product found here is trusted as the page
 * product because the path itself is the signal (e.g. `props.pageProps.product`).
 */
function nextDataKnownProduct(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const PATHS: string[][] = [
    ["props", "pageProps", "product"],
    ["props", "pageProps", "productData"],
    ["props", "pageProps", "initialData", "product"],
    ["props", "pageProps", "page", "product"],
    ["props", "pageProps", "__APOLLO_STATE__", "product"],
    ["query", "product"],
  ];
  for (const path of PATHS) {
    let node: unknown = data;
    for (const key of path) {
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[key];
    }
    if (isProductLike(node)) return node;
  }
  return undefined;
}

/**
 * Mirrors Rust `collect_product_like`: collects product-like objects anywhere in
 * the payload. A product-like node is treated as a leaf (we do not descend into
 * its own subtree) so its offers / variants are not counted as candidates.
 */
function collectProductLike(
  value: unknown,
  out: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    for (const child of value) collectProductLike(child, out);
    return;
  }
  if (value && typeof value === "object") {
    if (isProductLike(value)) {
      out.push(value);
      return;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectProductLike(child, out);
    }
  }
}

/**
 * Mirrors Rust `node_matches_url`: does this node's url/handle/sku/id align with
 * the page URL? Compares case-insensitively, requiring an overlap of >= 3 chars.
 */
function nodeMatchesUrl(
  node: Record<string, unknown>,
  finalUrl: string,
): boolean {
  const url = finalUrl.toLowerCase();
  return [
    "url",
    "canonicalUrl",
    "handle",
    "slug",
    "sku",
    "id",
    "productId",
    "@id",
  ]
    .map(key => asString(node[key]))
    .filter((v): v is string => v !== undefined)
    .map(v => v.toLowerCase())
    .some(v => v.length >= 3 && (url.includes(v) || v.includes(url)));
}

/**
 * Mirrors Rust `select_next_data_product`. Prefers a known page-product path;
 * otherwise accepts a single product-like candidate, or disambiguates multiple
 * candidates by URL alignment. Returns undefined when the choice is ambiguous,
 * so we fail closed rather than emit a recommendation or cart item as the
 * requested product.
 */
function selectNextDataProduct(
  data: Record<string, unknown>,
  finalUrl: string,
): Record<string, unknown> | undefined {
  const known = nextDataKnownProduct(data);
  if (known !== undefined) return known;

  const candidates: Record<string, unknown>[] = [];
  collectProductLike(data, candidates);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const aligned = candidates.filter(node => nodeMatchesUrl(node, finalUrl));
  // Exactly one URL-aligned candidate wins; zero or many remain ambiguous.
  return aligned.length === 1 ? aligned[0] : undefined;
}

/**
 * Mirrors Rust `extract_next_data_structured`. Obtains the embedded-state JSON
 * object, selects the page product (fail-closed), and normalizes it. The chosen
 * node already looks like a Product/offers shape, so it shares the JSON-LD
 * normalize step.
 */
function parseEmbeddedState(html: string, baseUrl: string): RawProduct | null {
  const data = extractEmbeddedStateJson(html);
  if (data === undefined) return null;
  const node = selectNextDataProduct(data, baseUrl);
  if (node === undefined) return null;
  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// runParams source (AliExpress)
// ---------------------------------------------------------------------------

/**
 * Walk a nested object/array path (mirrors Rust serde `Value::pointer`),
 * returning the leaf value or undefined when any segment is missing.
 */
function pointer(value: unknown, ...path: string[]): unknown {
  let node: unknown = value;
  for (const key of path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Mirrors Rust `extract_runparams_structured`. AliExpress ships the full product
 * object in static HTML as `window.runParams = {...}` (no JSON-LD / SSR-state).
 *
 * We anchor on the assignment (`runParams = `, tolerating whitespace variants,
 * falling back to the bare word last) so a stray earlier `runParams` mention
 * can't shadow the real payload. The product node is `runParams.data` (newer
 * pages) or the object itself (older inline builds). Fail-closed: returns null
 * unless a title or price is found. Currency only when the payload provides it.
 */
function parseRunParams(html: string, baseUrl: string): RawProduct | null {
  const obj =
    jsonObjectAfter(html, "runParams = ") ??
    jsonObjectAfter(html, "runParams =") ??
    jsonObjectAfter(html, "runParams=") ??
    jsonObjectAfter(html, "runParams");
  if (obj === undefined) return null;

  // Newer pages wrap the product under `data`; older ones inline it.
  const dataValue = obj["data"];
  const data: Record<string, unknown> =
    dataValue && typeof dataValue === "object" && !Array.isArray(dataValue)
      ? (dataValue as Record<string, unknown>)
      : obj;

  const name =
    asString(pointer(data, "titleModule", "subject")) ??
    asString(pointer(data, "pageModule", "title"));
  // Prefer the activity (sale) price, then the base price.
  const price =
    asNumber(pointer(data, "priceModule", "minActivityAmount", "value")) ??
    asNumber(pointer(data, "priceModule", "minAmount", "value"));
  if (name === undefined && price === undefined) return null;

  const currency =
    asString(pointer(data, "priceModule", "minActivityAmount", "currency")) ??
    asString(pointer(data, "priceModule", "minAmount", "currency"));
  const availQuantity = asNumber(
    pointer(data, "quantityModule", "totalAvailQuantity"),
  );
  const description = asString(pointer(data, "pageModule", "description"));
  const image = asString(pointer(data, "pageModule", "imagePath"));

  const offers: Record<string, unknown> = {};
  if (price !== undefined) offers["price"] = price;
  if (currency !== undefined) offers["priceCurrency"] = currency;
  if (availQuantity !== undefined) {
    offers["availability"] =
      availQuantity > 0
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock";
  }

  const node: Record<string, unknown> = { "@type": "Product", offers };
  if (name !== undefined) node["name"] = name;
  if (description !== undefined) node["description"] = description;
  if (image !== undefined) node["image"] = image;

  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// RDFa source
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `rdfa_property_value`: read a single RDFa `property` value with
 * the precedence `content` attribute -> `href`/`src` attribute -> trimmed inner
 * text. The `property` token may carry a namespace prefix (e.g. `schema:name`),
 * so we match the suffix after any `:` separator.
 */
function rdfaPropertyValue($: CheerioAPI, prop: string): string | undefined {
  const matches = $(`[property]`).filter((_, el) => {
    const raw = $(el).attr("property") ?? "";
    return raw
      .trim()
      .split(/\s+/)
      .some(token => token.split(":").pop() === prop);
  });
  for (let i = 0; i < matches.length; i++) {
    const node = $(matches[i]);
    const content = node.attr("content");
    if (content !== undefined && content.trim() !== "") return content.trim();
    const href = node.attr("href") ?? node.attr("src");
    if (href !== undefined && href.trim() !== "") return href.trim();
    const text = node.text().trim();
    if (text !== "") return text;
  }
  return undefined;
}

/**
 * Mirrors Rust `extract_rdfa_structured`. Reads a Product expressed via RDFa
 * (`typeof` containing `Product`). Like microdata, requires EXACTLY ONE Product
 * `typeof` scope: zero or several are ambiguous, so we fail closed (return null)
 * rather than guess which scope is the page product. The collected `property`
 * values are shaped like the JSON-LD node the shared normalizer expects.
 */
function parseRdfa(html: string, baseUrl: string): RawProduct | null {
  const $ = load(html);
  const scopes = $("[typeof]").filter((_, el) => {
    const raw = $(el).attr("typeof") ?? "";
    return raw
      .trim()
      .split(/\s+/)
      .some(token => token.split(":").pop() === "Product");
  });
  if (scopes.length !== 1) return null; // zero or ambiguous -> fail closed

  const name = rdfaPropertyValue($, "name");
  const price = asNumber(rdfaPropertyValue($, "price"));
  if (name === undefined && price === undefined) return null;

  const currency = rdfaPropertyValue($, "priceCurrency");
  const availabilityRaw = rdfaPropertyValue($, "availability");
  const availability =
    availabilityRaw !== undefined
      ? availabilityToken(availabilityRaw)
      : undefined;

  const offers: Record<string, unknown> = {};
  if (price !== undefined) offers["price"] = price;
  if (currency !== undefined) offers["priceCurrency"] = currency;
  if (availability !== undefined) offers["availability"] = availability;

  const node: Record<string, unknown> = { "@type": "Product", offers };
  if (name !== undefined) node["name"] = name;
  const brand = rdfaPropertyValue($, "brand");
  if (brand !== undefined) node["brand"] = brand;
  const description = rdfaPropertyValue($, "description");
  if (description !== undefined) node["description"] = description;
  const image = rdfaPropertyValue($, "image");
  if (image !== undefined) node["image"] = image;

  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// GA4 dataLayer source
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `extract_datalayer_structured`. Recovers a single page product
 * from a GA4 `view_item` / UA enhanced-ecommerce `ecommerce` payload embedded in
 * an inline script. Prefers a single-product `view_item` push, then falls back
 * to a bare `ecommerce` object. Fail-closed: requires EXACTLY ONE product item,
 * since item-list / impression events carry many. Currency only when sourced.
 */
function parseDataLayer(html: string, baseUrl: string): RawProduct | null {
  const payload =
    jsonObjectAfter(html, "view_item',") ??
    jsonObjectAfter(html, 'view_item",') ??
    jsonObjectAfter(html, "ecommerce");
  if (payload === undefined) return null;

  const asItems = (value: unknown): Record<string, unknown>[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value.filter(
      (v): v is Record<string, unknown> =>
        v !== null && typeof v === "object" && !Array.isArray(v),
    );
  };

  const items =
    asItems(payload["items"]) ??
    asItems(pointer(payload, "detail", "products")) ??
    asItems(pointer(payload, "ecommerce", "items")) ??
    asItems(pointer(payload, "ecommerce", "detail", "products")) ??
    [];

  if (items.length !== 1) return null; // zero or a list -> not a single product
  const item = items[0];

  const name = asString(item["item_name"]) ?? asString(item["name"]);
  const price = asNumber(item["price"]);
  if (name === undefined && price === undefined) return null;

  // currency: item-level, else top-level event currency; never fabricated.
  const currency = asString(item["currency"]) ?? asString(payload["currency"]);
  const brand = asString(item["item_brand"]) ?? asString(item["brand"]);
  const category =
    asString(item["item_category"]) ?? asString(item["category"]);

  const offers: Record<string, unknown> = {};
  if (price !== undefined) offers["price"] = price;
  if (currency !== undefined) offers["priceCurrency"] = currency;

  const node: Record<string, unknown> = { "@type": "Product", offers };
  if (name !== undefined) node["name"] = name;
  if (brand !== undefined) node["brand"] = brand;
  if (category !== undefined) node["category"] = category;

  return normalizeStructuredProduct(node, baseUrl);
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/** Mirrors Rust `first_offer`: first element of `offers` array, or the object. */
function firstOffer(
  product: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const offers = product["offers"];
  if (Array.isArray(offers)) {
    const first = offers[0];
    return first && typeof first === "object"
      ? (first as Record<string, unknown>)
      : undefined;
  }
  if (offers && typeof offers === "object") {
    return offers as Record<string, unknown>;
  }
  return undefined;
}

/** Mirrors Rust `normalize_brand` / `structured_brand`: string or `{name}`. */
function normalizeBrand(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return asString((value as Record<string, unknown>)["name"]);
  }
  return undefined;
}

/** Mirrors Rust `structured_category`: string, `{name}`, or last of an array. */
function normalizeCategory(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strings = value
      .map(
        v => asString(v) ?? asString((v as Record<string, unknown>)?.["name"]),
      )
      .filter((s): s is string => s !== undefined);
    return strings.length ? strings[strings.length - 1] : undefined;
  }
  if (value && typeof value === "object") {
    return asString((value as Record<string, unknown>)["name"]);
  }
  return undefined;
}

/**
 * Mirrors Rust `normalize_images` -> `structured_images`: accept a string,
 * an array of strings/objects, or a single object, and collapse to
 * `{url, alt?}` entries keyed off `src` or `url`.
 */
function normalizeImages(value: unknown): ProductImage[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw: unknown[] = Array.isArray(value) ? value : [value];
  const images: ProductImage[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      images.push({ url: item });
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const url = asString(obj["src"]) ?? asString(obj["url"]);
      if (url) {
        const alt = asString(obj["alt"]);
        images.push(alt ? { url, alt } : { url });
      }
    }
  }
  return images.length ? images : undefined;
}

/**
 * Mirrors Rust `normalize_availability_text`: collapse a schema.org
 * availability token to a human-readable string.
 */
function normalizeAvailabilityText(text: string): string {
  const token = text.split(/[/#]/).pop() ?? text;
  switch (token) {
    case "InStock":
    case "InStoreOnly":
    case "OnlineOnly":
      return "In stock";
    case "LimitedAvailability":
      return "Limited availability";
    case "OutOfStock":
    case "SoldOut":
      return "Out of stock";
    case "PreOrder":
      return "Preorder";
    case "PreSale":
      return "Presale";
    case "BackOrder":
      return "Backorder";
    case "Discontinued":
      return "Discontinued";
    default:
      return text;
  }
}

/**
 * Mirrors Rust `structured_availability`: availability lives on the product or
 * the first offer, as a raw token or `{text, inStock}` object. `inStock` is the
 * explicit boolean when present, else true unless the token says out of stock.
 */
function normalizeAvailability(
  product: Record<string, unknown>,
  offer: Record<string, unknown> | undefined,
): ProductAvailability | undefined {
  const availability =
    product["availability"] ?? offer?.["availability"] ?? undefined;
  if (availability === undefined || availability === null) return undefined;

  let rawText: string | undefined;
  let explicitInStock: boolean | undefined;
  if (typeof availability === "object" && !Array.isArray(availability)) {
    const obj = availability as Record<string, unknown>;
    rawText = asString(obj["text"]);
    if (typeof obj["inStock"] === "boolean") {
      explicitInStock = obj["inStock"] as boolean;
    }
  } else {
    rawText = asString(availability);
  }

  const inStock =
    explicitInStock ??
    (rawText !== undefined
      ? !rawText.toLowerCase().includes("outofstock")
      : true);
  const text =
    rawText !== undefined ? normalizeAvailabilityText(rawText) : undefined;
  return text !== undefined ? { inStock, text } : { inStock };
}

/**
 * Currency-aware price formatting, mirroring Rust `format_price`: `$49.99` for
 * USD/unknown-but-present currency styling, `49.99 EUR` otherwise. Only built
 * when a currency is known.
 */
function formatPrice(amount: number, currency: string): string {
  return currency === "USD"
    ? `$${amount.toFixed(2)}`
    : `${amount.toFixed(2)} ${currency}`;
}

/**
 * Canonical mapping, ported from Rust `normalize_structured_product`.
 * Notably: currency is emitted ONLY when sourced (never defaulting to USD), and
 * `formatted` is present only when a currency is known.
 */
function normalizeStructuredProduct(
  node: Record<string, unknown>,
  baseUrl: string,
): RawProduct {
  const offer = firstOffer(node);
  const raw: RawProduct = {};

  // id: sku -> productID -> productId
  const id =
    asString(node["sku"]) ??
    asString(node["productID"]) ??
    asString(node["productId"]);
  if (id !== undefined) raw.id = id;

  const sku = asString(node["sku"]);
  if (sku !== undefined) raw.sku = sku;

  // title: name -> title
  const title = asString(node["name"]) ?? asString(node["title"]);
  if (title !== undefined) raw.title = title;

  const brand = normalizeBrand(node["brand"]);
  if (brand !== undefined) raw.brand = brand;

  const description = asString(node["description"]);
  if (description !== undefined) raw.description = description;

  // url: url -> @id (else baseUrl, applied at finalize)
  const url = asString(node["url"]) ?? asString(node["@id"]);
  if (url !== undefined) raw.url = url;

  // price: amount from product.price or offer.price; currency only when sourced.
  const amount = asNumber(node["price"]) ?? asNumber(offer?.["price"]);
  if (amount !== undefined) {
    const currency =
      asString(node["priceCurrency"]) ?? asString(offer?.["priceCurrency"]);
    const price: ProductPrice = { amount };
    if (currency !== undefined) {
      price.currency = currency;
      price.formatted = formatPrice(amount, currency);
    }
    raw.price = price;
  }

  const availability = normalizeAvailability(node, offer);
  if (availability !== undefined) raw.availability = availability;

  const images = normalizeImages(node["image"] ?? node["images"]);
  if (images !== undefined) raw.images = images;

  const category = normalizeCategory(node["category"]);
  if (category !== undefined) raw.category = category;

  // Variants are normalized in a later task; carry nothing here.
  void baseUrl;
  return raw;
}

// ---------------------------------------------------------------------------
// identity-aware multi-source merge
// ---------------------------------------------------------------------------

/**
 * Mirrors Rust `is_empty_json`: null/undefined, empty string, empty array, and
 * empty object all count as empty (so they don't satisfy first-non-empty-wins).
 */
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Mirrors Rust `structured_norm_title`: lower-cased, whitespace-collapsed title,
 * or undefined when absent/empty.
 */
function structuredNormTitle(product: RawProduct): string | undefined {
  const title = product.title;
  if (title === undefined) return undefined;
  const normalized = title.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return normalized !== "" ? normalized : undefined;
}

/**
 * Mirrors Rust `structured_ident`: trimmed, lower-cased identity value
 * (`id`/`sku`) of an intermediate product, or undefined when absent/empty.
 */
function structuredIdent(
  product: RawProduct,
  key: "id" | "sku",
): string | undefined {
  const value = product[key];
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" ? normalized : undefined;
}

/**
 * Mirrors Rust `structured_sources_conflict`: true when two intermediate
 * products clearly describe DIFFERENT products — their titles disagree (and
 * neither contains the other), or their `id`/`sku` disagree. A source that
 * merely lacks identity fields (e.g. an OpenGraph price-only fragment) never
 * conflicts, so gap-filling still works.
 */
function structuredSourcesConflict(
  anchor: RawProduct,
  other: RawProduct,
): boolean {
  const a = structuredNormTitle(anchor);
  const b = structuredNormTitle(other);
  if (a !== undefined && b !== undefined) {
    if (a !== b && !a.includes(b) && !b.includes(a)) return true;
  }
  for (const key of ["id", "sku"] as const) {
    const ai = structuredIdent(anchor, key);
    const bi = structuredIdent(other, key);
    if (ai !== undefined && bi !== undefined && ai !== bi) return true;
  }
  return false;
}

/**
 * Mirrors Rust `merge_structured_products`. `sources` must be ordered
 * highest-priority first. The first source anchors product identity;
 * lower-priority sources are merged only when they do not conflict with the
 * anchor's identity, so fields from a different product are never spliced
 * together. For each field, the first non-empty value among the kept sources
 * wins (first-wins by priority).
 */
function mergeStructuredProducts(sources: RawProduct[]): RawProduct {
  const [anchor, ...rest] = sources;
  const kept: RawProduct[] = [
    anchor,
    ...rest.filter(source => !structuredSourcesConflict(anchor, source)),
  ];

  const out: Record<string, unknown> = {};
  for (const field of STRUCTURED_FIELDS) {
    for (const source of kept) {
      const value = source[field];
      if (!isEmptyValue(value)) {
        out[field] = value;
        break;
      }
    }
  }
  return out as RawProduct;
}

// ---------------------------------------------------------------------------
// finalize + public API
// ---------------------------------------------------------------------------

/**
 * Resolve a (possibly relative) JSON-LD url/@id against the page baseUrl so the
 * emitted product/image urls are always absolute. Absolute urls pass through
 * unchanged; relative ones are resolved; a missing or unparseable url falls
 * back to baseUrl.
 */
function resolveUrl(maybeUrl: string | undefined, baseUrl: string): string {
  if (!maybeUrl) return baseUrl;
  try {
    return new URL(maybeUrl, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

function finalize(raw: RawProduct, baseUrl: string): ProductProfile {
  const profile: ProductProfile = {
    title: raw.title!,
    url: resolveUrl(raw.url, baseUrl),
    variants: raw.variants ?? [],
  };
  if (raw.brand !== undefined) profile.brand = raw.brand;
  if (raw.category !== undefined) profile.category = raw.category;
  if (raw.description !== undefined) profile.description = raw.description;
  if (raw.images !== undefined)
    profile.images = raw.images.map(img => ({
      ...img,
      url: resolveUrl(img.url, baseUrl),
    }));
  if (raw.price !== undefined) profile.price = raw.price;
  if (raw.originalPrice !== undefined)
    profile.originalPrice = raw.originalPrice;
  if (raw.availability !== undefined) profile.availability = raw.availability;
  return profile;
}

/**
 * Extract a single structured product from a page's HTML.
 *
 * Sources from JSON-LD, microdata, RDFa, embedded state (__NEXT_DATA__ /
 * framework hydration blobs), runParams (AliExpress), dataLayer (GA4), then
 * OpenGraph/<meta>, in that priority order, and field-merges them: the
 * highest-priority source anchors identity and lower-priority, non-conflicting
 * sources gap-fill missing fields. Returns null when no product node with a
 * title is found (non-ecommerce / nav / link pages). Signature is STABLE.
 */
export async function extractProducts(
  html: string,
  baseUrl: string,
): Promise<ProductProfile | null> {
  try {
    // Collect every source result in priority order (highest first), dropping
    // the ones that found no product, then field-merge them. Priority:
    // JSON-LD > microdata > RDFa > embedded-state > runParams > dataLayer >
    // OpenGraph/<meta>. The merge anchors identity on the highest-priority
    // source and only gap-fills from lower-priority, non-conflicting sources.
    const sources = [
      parseJsonLd(html, baseUrl),
      parseMicrodata(html, baseUrl),
      parseRdfa(html, baseUrl),
      parseEmbeddedState(html, baseUrl),
      parseRunParams(html, baseUrl),
      parseDataLayer(html, baseUrl),
      parseOpenGraph(html, baseUrl),
    ].filter((s): s is RawProduct => s !== null);

    if (sources.length === 0) return null;
    const merged = mergeStructuredProducts(sources);
    return merged.title ? finalize(merged, baseUrl) : null;
  } catch (error) {
    logger.warn("extractProducts failed", {
      error,
      module: "scrapeURL",
      method: "extractProducts",
    });
    return null;
  }
}
