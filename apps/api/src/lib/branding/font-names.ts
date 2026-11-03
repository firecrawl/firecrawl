// Which family in a font stack is the one visitors see, and vendor spellings
// of family names. Shared by the processor (counting fonts) and the Jev
// client (naming them), so the two never disagree about what a stack means.

export const GENERIC_FONTS = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "initial",
  "emoji",
  "math",
]);

// A stack that starts with one of these asks for the visitor's system font;
// the named faces after it (Segoe UI, Roboto, Helvetica Neue) are only the
// per-platform spellings of that request, not fonts the brand chose.
const SYSTEM_STACK_HEADS = new Set([
  "system-ui",
  "-apple-system",
  "blinkmacsystemfont",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
]);

/**
 * Site builders serve a licensed face under a per-site alias and keep the
 * real name further down the stack: Wix's `wfont_<site>_<hash>` and
 * `wf_<hash>`, then `orig_<family>`. The alias says nothing about the font.
 */
const isHashedAlias = (family: string): boolean =>
  /^wfont_[0-9a-f]{6}_[0-9a-f]{32}$/i.test(family) ||
  /^wf_[0-9a-f]{20,}$/i.test(family) ||
  /^[a-z]{1,6}_[0-9a-f]{24,}$/i.test(family);

const unquote = (family: string) =>
  family
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();

/**
 * What a stack is set in when it names no brand face: the system font
 * ("-apple-system" and "BlinkMacSystemFont" are system-ui; "ui-serif" and
 * "ui-monospace" are themselves), or its generic family ("sans-serif").
 * For reporting a page's typography.
 */
export const genericFamily = (stack: readonly string[]): string | undefined => {
  const first = stack.map(unquote).find(Boolean);
  if (!first) return undefined;
  const head = first.toLowerCase();
  if (head === "-apple-system" || head === "blinkmacsystemfont") {
    return "system-ui";
  }
  return GENERIC_FONTS.has(head) ? head : undefined;
};

/**
 * The family a stack renders: its first entry that is a real face, past any
 * hashed aliases. A stack led by a system keyword renders the system font
 * and names no brand face; a stack of generics names none either.
 */
export function renderedFamily(stack: readonly string[]): string | undefined {
  const families = stack.map(unquote).filter(Boolean);
  if (families.length === 0) return undefined;
  if (SYSTEM_STACK_HEADS.has(families[0].toLowerCase())) return undefined;
  for (const family of families) {
    if (/^var\(/i.test(family)) continue;
    if (isHashedAlias(family)) continue;
    // A one-letter or digits-only "family" is a broken declaration. Any
    // script counts: brands set in CJK or Cyrillic faces name them as such.
    if (!/\p{L}.*\p{L}/u.test(family)) continue;
    if (GENERIC_FONTS.has(family.toLowerCase())) return undefined;
    return family;
  }
  return undefined;
}

// Monotype and Wix spellings that hide a family name: "helvetica-w01-roman",
// "futura-lt-w01-book", "proxima-n-w01-reg", "open-sans-v2", and the
// `orig_` prefix Wix puts on the face behind an alias.
const VENDOR_SUFFIX =
  /(?:[-_]?lt)?[-_]?w0\d(?:[-_]?(?:regular|reg|roman|book|bold|light|medium|italic|it))?[-_]*$/i;
const KNOWN_FAMILIES = new Map<string, string>([
  ["dinneuzeitgrotesk", "DIN Neuzeit Grotesk"],
  ["proximan", "Proxima Nova"],
  ["proximanova", "Proxima Nova"],
  ["helveticaneue", "Helvetica Neue"],
  ["avenir", "Avenir"],
  ["avenirnext", "Avenir Next"],
  ["futura", "Futura"],
  ["opensans", "Open Sans"],
]);

/** The proper spelling of a family the vendor spells its own way, if we know it. */
export const knownFamily = (name: string): string | undefined =>
  KNOWN_FAMILIES.get(name.toLowerCase().replace(/[\s_-]/g, ""));

/**
 * Strips vendor prefixes and suffixes (orig_, -v2, -w01-roman, build
 * suffixes such as -variable-web); a name that matches a known family gets
 * its proper spelling.
 */
export function normalizeVendorName(name: string): string {
  let out = name.replace(/^orig_/i, "").replace(/-v\d+$/i, "");
  if (VENDOR_SUFFIX.test(out) && out.replace(VENDOR_SUFFIX, "").length >= 3) {
    out = out.replace(VENDOR_SUFFIX, "");
  }
  out = out.replace(/(?:[-_]+(?:variable|vf|web|webfont))+$/i, "");
  return knownFamily(out) ?? out;
}

/** First letter of each word up, in any script: "über grotesk" → "Über Grotesk". */
export const titleCase = (name: string): string =>
  name.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

/**
 * A family name as the API reports it: vendor spellings resolved,
 * underscores read as spaces, and an all-lowercase alias title-cased.
 * The Jev client goes further (weights, camel case); this is the shared
 * floor the processor's own output also meets.
 */
export function displayFamily(name: string): string {
  let out = normalizeVendorName(name)
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out && out === out.toLowerCase()) out = titleCase(out);
  return knownFamily(out) ?? out;
}
