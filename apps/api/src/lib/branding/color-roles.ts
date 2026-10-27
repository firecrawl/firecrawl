/** CIE-ish luma used to tell chrome (near-black / near-white) from brand color. */
export function contrastYIQ(hex: string): number {
  if (!hex) return 0;
  const h = hex.replace("#", "");
  if (h.length < 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

export function isGrayish(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return true;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 15;
}

export function isNearBlack(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return contrastYIQ(hex) < 40;
  const max = Math.max(
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  );
  // YIQ alone treats saturated blue (#0000FF) as near-black. Require a dark
  // channel max so navy chrome (#000080 max 128, #061B31 max 49) matches
  // and full-bright brand blues do not.
  return contrastYIQ(hex) < 40 && max < 140;
}

/** Near-black with no hue: a monochrome brand's black, not navy chrome. */
export function isNeutralDark(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return false;
  const channels = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return isNearBlack(hex) && Math.max(...channels) - Math.min(...channels) < 30;
}

/** Straight-line RGB distance; Infinity unless both are #RRGGBB. */
export function colorDistance(a?: string | null, b?: string | null): number {
  const x = normalizeRoleHex(a);
  const y = normalizeRoleHex(b);
  if (!x || !y || x.length !== 7 || y.length !== 7) return Infinity;
  const channels = (hex: string) =>
    [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const [p, q] = [channels(x), channels(y)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Nearly white, whatever its tint (#E5EDF5, #F2E8E1): on a light page that is
 * a section background, not a brand color.
 */
export function isPale(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return false;
  const channels = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return (Math.max(...channels) + Math.min(...channels)) / 2 / 255 > 0.9;
}

/** A light color on a light page, a dark one on a dark page: what a page background can be. */
export function fitsColorScheme(
  hex: string,
  colorScheme?: "light" | "dark",
): boolean {
  const luma = contrastYIQ(hex);
  return colorScheme === "dark" ? luma < 128 : luma >= 128;
}

/**
 * Able to call attention to a button or link: a monochrome brand's black (white
 * on a dark page), or a color with real chroma that isn't a pale tint on a
 * light page. Grays and slates (#A2A9B1, #4A5565) are chrome.
 */
export function isUsableAccent(
  hex: string,
  colorScheme?: "light" | "dark",
): boolean {
  if (colorScheme === "dark" ? contrastYIQ(hex) > 200 : isNearBlack(hex)) {
    return hex.replace("#", "").length >= 6;
  }
  return isChromaticAccent(hex, colorScheme);
}

/** A color with real chroma that isn't a pale tint on a light page: what the page's own colored elements can offer as an accent. Grays, slates (#4A5565), black and white are not it. */
export function isChromaticAccent(
  hex: string,
  colorScheme?: "light" | "dark",
): boolean {
  const h = hex.replace("#", "");
  if (h.length < 6) return false;
  const channels = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  if (Math.max(...channels) - Math.min(...channels) < 30) return false;
  return colorScheme === "dark" || !isPale(hex);
}

/** Chromatic brand color — not gray chrome, and not near-black or near-white chrome on light pages. */
export function isUsableBrandPrimary(
  hex: string,
  colorScheme?: "light" | "dark",
): boolean {
  if (isGrayish(hex)) return false;
  if (colorScheme !== "dark" && (isNearBlack(hex) || isPale(hex))) return false;
  return true;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// What browsers draw unstyled links in (unvisited, visited). A page that shows
// them never chose them, so they say nothing about the brand.
const BROWSER_LINK_COLORS = new Set(["#0000EE", "#551A8B"]);

export function isBrowserLinkColor(value?: string | null): boolean {
  const hex = normalizeRoleHex(value);
  return !!hex && BROWSER_LINK_COLORS.has(hex);
}

/** Accept #RGB / #RRGGBB; reject names like "navy" so they cannot overwrite heuristics. */
export function normalizeRoleHex(value?: string | null): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!HEX.test(raw)) return undefined;
  const h = raw.slice(1);
  const full =
    h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : raw;
  return full.toUpperCase();
}

/**
 * Brand primary is a chromatic color — not page chrome.
 * On light pages, skip near-black (navy headers, dark nav bars).
 */
export function pickBrandPrimary(
  ranked: string[],
  opts: {
    background?: string;
    textPrimary?: string;
    colorScheme?: "light" | "dark";
  },
): string {
  const skip = new Set(
    [opts.background, opts.textPrimary].filter((h): h is string => !!h),
  );
  const lightPage = opts.colorScheme !== "dark";

  const chromatic = ranked.find(h => {
    if (skip.has(h) || isGrayish(h)) return false;
    if (lightPage && (isNearBlack(h) || isPale(h))) return false;
    return true;
  });
  if (chromatic) return chromatic;

  return (
    ranked.find(h => !isGrayish(h) && !skip.has(h)) ||
    (lightPage ? "#000000" : "#FFFFFF")
  );
}

/** Inclusive 0.5 bar — models often return exactly 0.5 when uncertain. Rescue header chrome down to 0.4. */
const LLM_COLOR_CONFIDENCE = 0.5;

export function shouldApplyLlmColorRoles(
  confidence: number,
  llmPrimary?: string,
  heuristicPrimary?: string,
  colorScheme?: "light" | "dark",
): boolean {
  if (confidence >= LLM_COLOR_CONFIDENCE) return true;
  if (confidence < 0.4) return false;
  const llm = normalizeRoleHex(llmPrimary);
  if (!llm || isGrayish(llm) || isNearBlack(llm)) return false;
  return (
    colorScheme !== "dark" &&
    !!heuristicPrimary &&
    isNearBlack(heuristicPrimary)
  );
}
