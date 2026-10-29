// Shrink raw HTML into a compact, selector-faithful sample for the codegen model:
// drop noise, keep structure and selector attributes, collapse repeats, clip to a
// budget.
import { COMMENT_NODE, ELEMENT_NODE, parseDocument, TEXT_NODE } from "./dom";

interface SimplifyOptions {
  maxTextLen?: number;
  maxAttrLen?: number;
  maxClassNames?: number;
  keepRepeats?: number;
  maxTotalLen?: number;
}

const DEFAULTS = {
  maxTextLen: 160,
  maxAttrLen: 96,
  maxClassNames: 12,
  keepRepeats: 3,
  maxJsonLdLen: 4_000,
  maxTotalLen: 40_000,
};
type Opts = typeof DEFAULTS;

// Tags whose content never helps a selector. SVG/MATH/CANVAS are kept as empty
// elements (their guts are huge and useless); the rest are removed entirely.
const REMOVE_TAGS = new Set([
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "LINK",
  "BR",
  "WBR",
  "SOURCE",
  "IFRAME",
]);
const EMPTY_TAGS = new Set(["SVG", "MATH", "CANVAS"]);

const DROP_ATTRS = new Set([
  "style",
  "integrity",
  "nonce",
  "crossorigin",
  "referrerpolicy",
  "decoding",
  "loading",
  "fetchpriority",
  "sizes",
  "autocomplete",
  "spellcheck",
  "tabindex",
]);
const URL_ATTRS = new Set(["href", "src", "data-src", "poster", "action"]);
const TRUNCATE_ATTRS = new Set([
  "src",
  "href",
  "srcset",
  "data-src",
  "poster",
  "action",
  "content",
  "value",
  "alt",
  "title",
  "aria-label",
]);
const KEEP_META = new Set([
  "title",
  "description",
  "author",
  "date",
  "pubdate",
  "article:published_time",
]);

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}...[+${s.length - max}]`;

const collapseSpace = (s: string): string => s.replace(/\s+/g, " ").trim();

// Keep a URL's origin + first path segment (the strongest selector hint) and
// drop the slug tail, rather than blindly cutting the string.
function truncateUrl(value: string, max: number): string {
  if (value.length <= max) return value;
  try {
    const u = new URL(value, "https://x.invalid");
    const seg = u.pathname.split("/").filter(Boolean)[0];
    const head = `${u.origin === "https://x.invalid" ? "" : u.origin}/${seg ?? ""}`;
    if (head.length < max) return `${head}/...[+${value.length - head.length}]`;
  } catch {
    /* fall through */
  }
  return truncate(value, max);
}

const isJsonLd = (el: Element): boolean =>
  el.tagName === "SCRIPT" &&
  (el.getAttribute("type") ?? "").toLowerCase() === "application/ld+json";

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true")
    return true;
  if (
    el.tagName === "INPUT" &&
    (el.getAttribute("type") ?? "").toLowerCase() === "hidden"
  )
    return true;
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(
    el.getAttribute("style") ?? "",
  );
}

function pruneHead(doc: Document): void {
  const head = doc.querySelector("head");
  if (!head) return;
  for (const el of Array.from(head.children)) {
    if (el.tagName === "TITLE" || isJsonLd(el)) continue;
    if (el.tagName === "META") {
      const key = (
        el.getAttribute("name") ??
        el.getAttribute("property") ??
        ""
      ).toLowerCase();
      if (
        KEEP_META.has(key) ||
        key.startsWith("og:") ||
        key.startsWith("twitter:")
      )
        continue;
    }
    el.remove();
  }
}

function cleanAttributes(el: Element, opts: Opts): void {
  for (const name of el.getAttributeNames()) {
    const lower = name.toLowerCase();
    if (
      DROP_ATTRS.has(lower) ||
      lower.startsWith("on") ||
      /^data-(react|next|astro|svelte|vue|emotion|styled|gtm|ga|analytics|tracking|cookie|consent)/.test(
        lower,
      )
    ) {
      el.removeAttribute(name);
      continue;
    }
    const value = el.getAttribute(name) ?? "";
    if (lower === "class") {
      const classes = [...new Set(value.split(/\s+/).filter(Boolean))].slice(
        0,
        opts.maxClassNames,
      );
      classes.length
        ? el.setAttribute(name, classes.join(" "))
        : el.removeAttribute(name);
    } else if (value.startsWith("data:")) {
      el.setAttribute(name, "data:...");
    } else if (URL_ATTRS.has(lower)) {
      el.setAttribute(name, truncateUrl(value, opts.maxAttrLen));
    } else if (TRUNCATE_ATTRS.has(lower)) {
      el.setAttribute(name, truncate(value, opts.maxAttrLen));
    }
  }
}

// A signature for "same kind of element": tag + sorted classes + child tags.
// Used to collapse long runs of list items / table rows / cards.
function shapeKey(el: Element): string {
  const classes = (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(".");
  const childTags = Array.from(el.children)
    .slice(0, 5)
    .map(c => c.tagName)
    .join(",");
  return `${el.tagName}|${classes}|${childTags}`;
}

function collapseRepeats(parent: Element, opts: Opts): void {
  const groups = new Map<string, Element[]>();
  for (const el of Array.from(parent.children)) {
    const key = shapeKey(el);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(el);
  }
  for (const group of groups.values()) {
    // Only collapse a genuinely repeating run, not 2-3 incidental look-alikes.
    if (group.length < Math.max(5, opts.keepRepeats + 1)) continue;
    const extra = group.slice(opts.keepRepeats);
    const tag = group[0]!.tagName.toLowerCase();
    extra[0]!.parentNode?.insertBefore(
      parent.ownerDocument.createComment(
        ` ${extra.length} more <${tag}> with the same shape `,
      ),
      extra[0]!,
    );
    for (const el of extra) el.remove();
  }
}

function walk(node: Element, opts: Opts): void {
  for (const child of Array.from(node.childNodes)) {
    if (
      child.nodeType === COMMENT_NODE ||
      (child.nodeType !== ELEMENT_NODE && child.nodeType !== TEXT_NODE)
    ) {
      child.remove();
    } else if (child.nodeType === TEXT_NODE) {
      const text = collapseSpace(child.textContent ?? "");
      text
        ? (child.textContent = truncate(text, opts.maxTextLen))
        : child.remove();
    } else {
      const el = child as Element;
      if (isHidden(el) || REMOVE_TAGS.has(el.tagName)) {
        el.remove();
      } else if (el.tagName === "SCRIPT") {
        if (isJsonLd(el))
          el.textContent = truncate(
            collapseSpace(el.textContent ?? ""),
            opts.maxJsonLdLen,
          );
        else el.remove();
      } else if (EMPTY_TAGS.has(el.tagName)) {
        cleanAttributes(el, opts);
        el.textContent = "";
      } else {
        cleanAttributes(el, opts);
        walk(el, opts);
      }
    }
  }
  collapseRepeats(node, opts);
}

// Drop attribute-less <div>/<span> wrappers that hold a single element child -
// they add depth without selector value.
function flattenWrappers(el: Element): void {
  for (const child of Array.from(el.children)) flattenWrappers(child);
  if (
    (el.tagName !== "DIV" && el.tagName !== "SPAN") ||
    el.getAttributeNames().length
  )
    return;
  const childElements = Array.from(el.children);
  const hasOwnText = Array.from(el.childNodes).some(
    n => n.nodeType === TEXT_NODE && (n.textContent ?? "").trim(),
  );
  if (childElements.length === 1 && !hasOwnText)
    el.replaceWith(childElements[0]!);
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n<!-- ...${text.length - max} chars trimmed... -->\n`;
  const head = Math.ceil((max - marker.length) * 0.65);
  return (
    text.slice(0, head) + marker + text.slice(-(max - marker.length - head))
  );
}

export function simplifyHtml(
  html: string,
  options: SimplifyOptions = {},
): string {
  const opts = { ...DEFAULTS, ...options };
  const doc = parseDocument(html);
  pruneHead(doc);
  walk(doc.documentElement, opts);
  flattenWrappers(doc.documentElement);
  const out = doc.documentElement.outerHTML.replace(/>\s+</g, "><");
  return clipMiddle(out, opts.maxTotalLen);
}
