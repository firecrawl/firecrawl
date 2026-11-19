// Which family in a font stack is the one visitors see, and vendor spellings
// of family names. Shared by the processor (counting fonts) and the Jev
// client (naming them), so the two never disagree about what a stack means.

const GENERIC_FONTS = new Set([
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

// Faces that only carry symbols, listed ahead of the text face so their
// glyphs win: IKEA's currency faces ("Omani Rial", "Emirati Dirham"), and
// symbol and emoji sets. They never set the page's text.
const SYMBOL_FACE =
  /\b(?:rial|riyal|dirham|dinar|rupee|currency|symbols?|emoji)\b/i;

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
  const first = stack
    .map(unquote)
    .find(family => family && !SYMBOL_FACE.test(family));
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
function renderedFamily(stack: readonly string[]): string | undefined {
  const families = stack.map(unquote).filter(Boolean);
  if (families.length === 0) return undefined;
  if (SYSTEM_STACK_HEADS.has(families[0].toLowerCase())) return undefined;
  for (const family of families) {
    if (/^var\(/i.test(family)) continue;
    if (isHashedAlias(family)) continue;
    if (SYMBOL_FACE.test(family)) continue;
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
const knownFamily = (name: string): string | undefined =>
  KNOWN_FAMILIES.get(name.toLowerCase().replace(/[\s_-]/g, ""));

/**
 * Strips vendor prefixes and suffixes (orig_, -v2, -w01-roman, build
 * suffixes such as -variable-web); a name that matches a known family gets
 * its proper spelling.
 */
function normalizeVendorName(name: string): string {
  let out = name.replace(/^orig_/i, "").replace(/-v\d+$/i, "");
  if (VENDOR_SUFFIX.test(out) && out.replace(VENDOR_SUFFIX, "").length >= 3) {
    out = out.replace(VENDOR_SUFFIX, "");
  }
  out = out.replace(/(?:[-_]+(?:variable|vf|web|webfont))+$/i, "");
  return knownFamily(out) ?? out;
}

/** First letter of each word up, in any script: "über grotesk" → "Über Grotesk". */
const titleCase = (name: string): string =>
  name.replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

// Families can end in a heavy weight ("Cooper Black", "Arial Black"), so
// after a space only the weights no family name ends in are stripped. After a
// hyphen or underscore ("Roboto-Black") the name is a self-hosted face.
const SPACED_WEIGHTS =
  "regular|reg|medium|(?:semi|demi|extra|ultra)[-_\\s]?bold|bold|(?:extra|ultra)[-_\\s]?light|light|thin|hairline|italic|oblique";
const WEIGHTS = SPACED_WEIGHTS + "|book|black|heavy";
const FONT_WEIGHT = new RegExp("^\\s*(?:(?:" + WEIGHTS + ")\\s*)+$", "i");
const DELIMITED_WEIGHT_SUFFIX = new RegExp(
  "(?<=\\S)[_-]+(?:" + WEIGHTS + ")$",
  "i",
);
const FONT_WEIGHT_SUFFIX = new RegExp(
  "(?<=\\S)(?:[_-]+(?:" + WEIGHTS + ")|\\s+(?:" + SPACED_WEIGHTS + "))$",
  "i",
);
const GLUED_WEIGHT =
  /^([a-z]{3,}?)(?:extra|ultra|semi|demi)?(?:light|bold|medium|regular|book|black|heavy|thin)$/;

// Style and weight words a family name ends in. Glued onto a word
// ("GitLabSans", "figmaSans", "GmarketSansMedium") they are split off and the
// rest is kept as written, so brand words like GitLab and HubSpot stay whole.
const TRAILING_WORD =
  /(?<=\p{Ll})(Sans|Serif|Mono|Display|Text|Grotesk|Grotesque|Pro|Condensed|Rounded|Slab|(?:Extra|Ultra|Semi|Demi)?(?:Bold|Light)|Regular|Medium|Thin|Black|Heavy|Book|Italic|Oblique)$/u;

const splitWord = (word: string): string => {
  const tail: string[] = [];
  let stem = word;
  for (let m = stem.match(TRAILING_WORD); m; m = stem.match(TRAILING_WORD)) {
    tail.unshift(m[1]);
    stem = stem.slice(0, -m[1].length);
  }
  if (tail.length === 0) return word;
  const head =
    stem === stem.toLowerCase()
      ? stem.charAt(0).toUpperCase() + stem.slice(1)
      : stem;
  return [head, ...tail].join(" ");
};

// "GlacialIndifference" → "Glacial Indifference", "BasicCommercial LT Std" →
// "Basic Commercial LT Std": a word made only of whole capitalized parts
// splits, unless a style word follows it ("GitLab Sans", "PayPal Pro").
// "TIActuBeta" and "HardwoodLP" stay.
const STYLE_WORD =
  /^(?:Sans|Serif|Mono|Display|Text|Grotesk|Grotesque|Pro|Condensed|Rounded|Slab)$/;
const splitCamelCase = (name: string): string => {
  const words = name.split(" ").map(splitWord).join(" ").split(" ");
  return words
    .map((word, i) =>
      /^(?:[A-Z][a-z]{2,}){2,}$/.test(word) &&
      !STYLE_WORD.test(words[i + 1] ?? "")
        ? word.replace(/(?<=[a-z])(?=[A-Z])/g, " ")
        : word,
    )
    .join(" ");
};

/**
 * The one normalizer for a family name as the API reports it. Takes the raw
 * rendered name (or a whole stack) and strips next/font hashes, vendor
 * spellings and weights before it changes underscores or case.
 */
export function cleanFontFamily(
  raw: string | readonly string[],
): string | undefined {
  // A whole stack reports the family it renders: past hashed aliases, none
  // for a system stack ("-apple-system, BlinkMacSystemFont, Segoe UI").
  let name =
    renderedFamily(typeof raw === "string" ? raw.split(",") : raw) ?? "";
  if (!name) return undefined;
  if (/fallback/i.test(name)) return undefined;
  // next/font obfuscation: "__Roboto_Mono_c8ca7d" → "Roboto Mono"
  name = name.replace(/^_+/, "").replace(/_[0-9a-f]{6}$/i, "");
  // Vendor spellings and build suffixes: "orig_libre_baskerville",
  // "helvetica-w01-roman", "inter-variable-web".
  name = normalizeVendorName(name);
  if (FONT_WEIGHT.test(name)) return undefined;
  // A weight glued onto a lowercase name: "graphikextralight" → "graphik".
  const glued = name.match(GLUED_WEIGHT);
  if (glued && glued[1].length >= 4) name = knownFamily(glued[1]) ?? glued[1];
  // "Roboto_Black": the weight goes before underscores turn into spaces.
  while (DELIMITED_WEIGHT_SUFFIX.test(name))
    name = name.replace(DELIMITED_WEIGHT_SUFFIX, "");
  name = name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  // Or glued onto the last word of a lowercase alias: "nb international proregular".
  if (name === name.toLowerCase() && name.includes(" ")) {
    const words = name.split(" ");
    const last = words[words.length - 1].match(GLUED_WEIGHT);
    if (last) name = [...words.slice(0, -1), last[1]].join(" ");
  }
  // Variable-font builds name the same family: "Newsreader Variable".
  name = name.replace(/\s+(variable|vf)$/i, "");
  if (FONT_WEIGHT.test(name)) return undefined;
  // Self-hosted faces carry their weight: "OpenSans--Regular", "Inter Bold".
  name = splitCamelCase(name);
  while (FONT_WEIGHT_SUFFIX.test(name))
    name = name.replace(FONT_WEIGHT_SUFFIX, "");
  // A known family can only be matched once its weight is gone.
  name = knownFamily(name) ?? name;
  if (!name || GENERIC_FONTS.has(name.toLowerCase())) return undefined;
  if (name === name.toLowerCase()) name = titleCase(name);
  return name;
}
