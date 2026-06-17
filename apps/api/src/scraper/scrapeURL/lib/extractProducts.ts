import { load } from "cheerio"; // rustified
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
 * This file currently ships the JSON-LD source + the canonical normalize step.
 * Additional sources (microdata, RDFa, embedded state, OpenGraph) and the
 * priority merge land in later tasks. The public signature
 * `extractProducts(html, baseUrl)` is STABLE and must not change.
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
// finalize + public API
// ---------------------------------------------------------------------------

function finalize(raw: RawProduct, baseUrl: string): ProductProfile {
  const profile: ProductProfile = {
    title: raw.title!,
    url: raw.url ?? baseUrl,
    variants: raw.variants ?? [],
  };
  if (raw.brand !== undefined) profile.brand = raw.brand;
  if (raw.category !== undefined) profile.category = raw.category;
  if (raw.description !== undefined) profile.description = raw.description;
  if (raw.images !== undefined) profile.images = raw.images;
  if (raw.price !== undefined) profile.price = raw.price;
  if (raw.originalPrice !== undefined)
    profile.originalPrice = raw.originalPrice;
  if (raw.availability !== undefined) profile.availability = raw.availability;
  return profile;
}

/**
 * Extract a single structured product from a page's HTML.
 *
 * Currently sources from JSON-LD only. Returns null when no product node with a
 * title is found (non-ecommerce / nav / link pages). Signature is STABLE.
 */
export async function extractProducts(
  html: string,
  baseUrl: string,
): Promise<ProductProfile | null> {
  try {
    const raw = parseJsonLd(html, baseUrl);
    return raw && raw.title ? finalize(raw, baseUrl) : null;
  } catch (error) {
    logger.warn("extractProducts failed", {
      error,
      module: "scrapeURL",
      method: "extractProducts",
    });
    return null;
  }
}
