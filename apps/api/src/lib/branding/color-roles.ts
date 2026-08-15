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

/** Chromatic brand color — not gray chrome, and not a near-black nav on light pages. */
export function isUsableBrandPrimary(
  hex: string,
  colorScheme?: "light" | "dark",
): boolean {
  if (isGrayish(hex)) return false;
  if (colorScheme !== "dark" && isNearBlack(hex)) return false;
  return true;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

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
    if (lightPage && isNearBlack(h)) return false;
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
