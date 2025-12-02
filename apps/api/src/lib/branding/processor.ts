import { BrandingProfile } from "../../types/branding";
import { BrandingScriptReturn } from "./types";
import { parse, rgb, formatHex } from "culori";

// Export for testing
export function hexify(
  rgba: string,
  background?: string | null,
): string | null {
  if (!rgba) return null;

  try {
    const color = parse(rgba);
    if (!color) return null;

    // Convert to RGB space
    const rgbColor = rgb(color);
    if (!rgbColor || rgbColor.mode !== "rgb") {
      return null;
    }

    let r = Math.round((rgbColor.r ?? 0) * 255);
    let g = Math.round((rgbColor.g ?? 0) * 255);
    let b = Math.round((rgbColor.b ?? 0) * 255);
    const alpha = rgbColor.alpha ?? 1;

    // Treat fully transparent colors as absent (not as black)
    if (alpha < 0.01) {
      return null;
    }

    // If color has alpha < 1, blend it with background before converting to hex
    // This prevents translucent overlays from being treated as opaque
    if (alpha < 1) {
      let bgR = 255; // Default to white
      let bgG = 255;
      let bgB = 255;

      // Try to parse background color if provided
      if (background) {
        try {
          const bgColor = parse(background);
          if (bgColor) {
            const bgRgb = rgb(bgColor);
            if (bgRgb && bgRgb.mode === "rgb") {
              const bgAlpha = bgRgb.alpha ?? 1;
              // Only use background color if it's not transparent
              // Transparent backgrounds should fall back to default white
              if (bgAlpha >= 0.01) {
                bgR = Math.round((bgRgb.r ?? 1) * 255);
                bgG = Math.round((bgRgb.g ?? 1) * 255);
                bgB = Math.round((bgRgb.b ?? 1) * 255);
              }
              // If bgAlpha < 0.01, keep default white values
            }
          }
        } catch (e) {
          // If background parsing fails, use white default
        }
      }

      // Alpha compositing: blend foreground with background
      // result = alpha * foreground + (1 - alpha) * background
      r = Math.round(alpha * r + (1 - alpha) * bgR);
      g = Math.round(alpha * g + (1 - alpha) * bgG);
      b = Math.round(alpha * b + (1 - alpha) * bgB);
    }

    // Clamp values to valid range
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));

    // Format as hex (always return #RRGGBB after blending)
    const rHex = r.toString(16).padStart(2, "0");
    const gHex = g.toString(16).padStart(2, "0");
    const bHex = b.toString(16).padStart(2, "0");
    return `#${rHex}${gHex}${bHex}`.toUpperCase();
  } catch (e) {
    return null;
  }
}

// Calculate contrast for text readability
function contrastYIQ(hex: string): number {
  if (!hex) return 0;
  const h = hex.replace("#", "");
  if (h.length < 6) return 0;
  const r = parseInt(h.slice(0, 2), 16),
    g = parseInt(h.slice(2, 4), 16),
    b = parseInt(h.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// Infer color palette from snapshots
function inferPalette(
  snapshots: BrandingScriptReturn["snapshots"],
  cssColors: string[],
  colorScheme?: "light" | "dark",
  pageBackground?: string | null,
) {
  const freq = new Map<string, number>();
  const bump = (hex: string | null, weight = 1) => {
    if (!hex) return;
    freq.set(hex, (freq.get(hex) || 0) + weight);
  };

  // Give very high weight to page background if available
  if (pageBackground) {
    const pageBgHex = hexify(pageBackground);
    if (pageBgHex) {
      bump(pageBgHex, 1000); // Much higher weight than other colors
    }
  }

  for (const s of snapshots) {
    const area = Math.max(1, s.rect.w * s.rect.h);
    // Blend semi-transparent colors with page background if available
    bump(
      hexify(s.colors.background, pageBackground),
      0.5 + Math.log10(area + 10),
    );
    bump(hexify(s.colors.text, pageBackground), 1.0);
    bump(hexify(s.colors.border, pageBackground), 0.3);
  }

  for (const c of cssColors) bump(hexify(c, pageBackground), 0.5);

  const ranked = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => h);

  const isGrayish = (hex: string) => {
    const h = hex.replace("#", "");
    if (h.length < 6) return true;
    const r = parseInt(h.slice(0, 2), 16),
      g = parseInt(h.slice(2, 4), 16),
      b = parseInt(h.slice(4, 6), 16);
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    return max - min < 15;
  };

  // Improved background detection that considers color scheme
  let background = "#FFFFFF"; // Default fallback

  if (pageBackground) {
    const pageBgHex = hexify(pageBackground);
    if (pageBgHex && isGrayish(pageBgHex)) {
      background = pageBgHex;
    }
  }

  if (background === "#FFFFFF" || (!pageBackground && ranked.length > 0)) {
    // If we don't have a good page background, infer from ranked colors
    if (colorScheme === "dark") {
      // For dark mode: look for dark grayish colors (low YIQ, but grayish)
      background =
        ranked.find(
          h => isGrayish(h) && contrastYIQ(h) < 128 && contrastYIQ(h) > 0,
        ) ||
        ranked.find(h => isGrayish(h) && contrastYIQ(h) < 180) ||
        "#1A1A1A";
    } else {
      // For light mode: look for light grayish colors (high YIQ and grayish)
      background =
        ranked.find(h => isGrayish(h) && contrastYIQ(h) > 180) || "#FFFFFF";
    }
  }

  const textPrimary =
    ranked.find(h => !/^#FFFFFF$/i.test(h) && contrastYIQ(h) < 160) ||
    (colorScheme === "dark" ? "#FFFFFF" : "#111111");
  const primary =
    ranked.find(h => !isGrayish(h) && h !== textPrimary && h !== background) ||
    (colorScheme === "dark" ? "#FFFFFF" : "#000000");
  const accent = ranked.find(h => h !== primary && !isGrayish(h)) || primary;

  // Collect all detected colors with their frequencies for debugging
  const allDetectedColors = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([hex, count]) => ({
      hex,
      frequency: count,
      isGrayish: isGrayish(hex),
      yiq: contrastYIQ(hex),
    }));

  const paletteResult = {
    primary,
    accent,
    background,
    textPrimary: textPrimary,
    link: accent,
  };

  return paletteResult;
}

// Infer spacing base unit
function inferBaseUnit(values: number[]): number {
  const vs = values
    .filter(v => Number.isFinite(v) && v > 0 && v <= 128)
    .map(v => Math.round(v));
  if (vs.length === 0) return 8;
  const candidates = [4, 6, 8, 10, 12];
  for (const c of candidates) {
    const ok =
      vs.filter(v => v % c === 0 || Math.abs((v % c) - c) <= 1 || v % c <= 1)
        .length / vs.length;
    if (ok >= 0.6) return c;
  }
  vs.sort((a, b) => a - b);
  const med = vs[Math.floor(vs.length / 2)];
  return Math.max(2, Math.min(12, Math.round(med / 2) * 2));
}

// Pick common border radius
function pickBorderRadius(radii: (number | null)[]): string {
  const rs = radii.filter((v): v is number => Number.isFinite(v));
  if (!rs.length) return "8px";
  rs.sort((a, b) => a - b);
  const med = rs[Math.floor(rs.length / 2)];
  return Math.round(med) + "px";
}

// Infer fonts list from stacks
function inferFontsList(
  fontStacks: string[][],
): Array<{ family: string; count: number }> {
  const freq: Record<string, number> = {};
  for (const stack of fontStacks) {
    for (const f of stack) {
      if (f) freq[f] = (freq[f] || 0) + 1;
    }
  }

  return Object.keys(freq)
    .sort((a, b) => freq[b] - freq[a])
    .slice(0, 10)
    .map(f => ({ family: f, count: freq[f] }));
}

// Pick logo from images
function pickLogo(images: Array<{ type: string; src: string }>): string | null {
  const byType = (t: string) => images.find(i => i.type === t)?.src;
  return (
    byType("logo") ||
    byType("logo-svg") ||
    byType("og") ||
    byType("twitter") ||
    byType("favicon") ||
    null
  );
}

// Process raw branding data into BrandingProfile
export function processRawBranding(raw: BrandingScriptReturn): BrandingProfile {
  const palette = inferPalette(
    raw.snapshots,
    raw.cssData.colors,
    raw.colorScheme,
    raw.pageBackground,
  );

  // Typography
  const typography = {
    fontFamilies: {
      primary: raw.typography.stacks.body[0] || "system-ui, sans-serif",
      heading:
        raw.typography.stacks.heading[0] ||
        raw.typography.stacks.body[0] ||
        "system-ui, sans-serif",
    },
    fontStacks: raw.typography.stacks,
    fontSizes: raw.typography.sizes,
  };

  // Spacing
  const baseUnit = inferBaseUnit(raw.cssData.spacings);
  const borderRadius = pickBorderRadius([
    ...raw.snapshots.map(s => s.radius),
    ...raw.cssData.radii,
  ]);

  // Fonts list (all font stacks flattened)
  const allFontStacks = [
    ...Object.values(raw.typography.stacks).flat(),
    ...raw.snapshots.map(s => s.typography.fontStack).flat(),
  ];
  const fontsList = inferFontsList([allFontStacks]);

  // Images
  const images = {
    logo: pickLogo(raw.images),
    favicon: raw.images.find(i => i.type === "favicon")?.src || null,
    ogImage:
      raw.images.find(i => i.type === "og")?.src ||
      raw.images.find(i => i.type === "twitter")?.src ||
      null,
  };

  // Components (empty for now - LLM will populate)
  const components = {
    input: {
      borderColor: "#CCCCCC",
      borderRadius: borderRadius,
    },
  };

  // Filter and score buttons
  const candidateButtons = raw.snapshots
    .filter(s => {
      if (!s.isButton) return false;
      if (s.rect.w < 30 || s.rect.h < 30) return false;
      if (!s.text || s.text.trim().length === 0) return false;

      // Include buttons with valid background OR buttons with borders (transparent bg + border is valid)
      const bgHex = hexify(s.colors.background, raw.pageBackground);

      // Check for borders: has borderWidth > 0 AND border color is not transparent
      const hasBorder = s.colors.borderWidth && s.colors.borderWidth > 0;
      const borderHex = hasBorder
        ? hexify(s.colors.border, raw.pageBackground)
        : null;

      // Include if has background OR has border (transparent buttons with borders are valid)
      // Note: borderHex might be null if border is transparent, but we still check hasBorder
      if (!bgHex && !hasBorder) return false;

      return true;
    })
    .map(s => {
      let score = 0;

      if (s.hasCTAIndicator) score += 1000;

      const text = (s.text || "").toLowerCase();
      const ctaKeywords = [
        "sign up",
        "get started",
        "start deploying",
        "start",
        "deploy",
        "try",
        "demo",
        "contact",
        "buy",
        "subscribe",
        "join",
        "register",
        "get",
        "free",
        "join",
      ];
      if (ctaKeywords.some(kw => text.includes(kw))) score += 500;

      const bgHex = hexify(s.colors.background, raw.pageBackground);
      const borderHex =
        s.colors.borderWidth && s.colors.borderWidth > 0
          ? hexify(s.colors.border, raw.pageBackground)
          : null;

      // Score for non-white backgrounds
      if (
        bgHex &&
        bgHex !== "#FFFFFF" &&
        bgHex !== "#FAFAFA" &&
        bgHex !== "#F5F5F5"
      ) {
        score += 300;
      }

      // Score for buttons with borders (transparent bg + border is a valid style)
      if (borderHex && !bgHex) {
        score += 200; // Less than colored background but still valid
      }

      if (text.length > 0 && text.length < 50) score += 100;

      const area = (s.rect.w || 0) * (s.rect.h || 0);
      score += Math.log10(area + 1) * 10;

      return { ...s, _score: score };
    })
    .sort((a: any, b: any) => (b._score || 0) - (a._score || 0));

  // Deduplicate buttons: same text + background + border + similar classes = same button
  const seenButtons = new Map<string, number>();
  const uniqueButtons: typeof candidateButtons = [];

  for (const button of candidateButtons) {
    const bgHex =
      hexify(button.colors.background, raw.pageBackground) || "transparent";
    const borderHex =
      button.colors.borderWidth && button.colors.borderWidth > 0
        ? hexify(button.colors.border, raw.pageBackground) ||
          "transparent-border"
        : "no-border";
    const textKey = (button.text || "").trim().toLowerCase().substring(0, 50);
    const classKey = (button.classes || "")
      .split(/\s+/)
      .slice(0, 5)
      .join(" ")
      .toLowerCase();

    // Create a signature: text + background + border + first 5 classes
    // Include border to distinguish buttons with same background but different borders
    const signature = `${textKey}|${bgHex}|${borderHex}|${classKey}`;

    if (!seenButtons.has(signature)) {
      seenButtons.set(signature, 1);
      uniqueButtons.push(button);
    } else {
      // If we've seen this button, increment count but don't add it
      seenButtons.set(signature, seenButtons.get(signature)! + 1);
    }
  }

  // Take top unique buttons (increased limit for more diversity)
  const topButtons = uniqueButtons.slice(0, 80);

  const buttonSnapshots = topButtons.map((s, idx) => {
    let bgHex = hexify(s.colors.background, raw.pageBackground);
    const borderHex =
      s.colors.borderWidth && s.colors.borderWidth > 0
        ? hexify(s.colors.border, raw.pageBackground)
        : null;

    if (!bgHex) {
      bgHex = "transparent";
    }

    return {
      index: idx,
      text: s.text || "",
      html: "",
      classes: s.classes || "",
      background: bgHex,
      textColor: hexify(s.colors.text, raw.pageBackground) || "#000000",
      borderColor: borderHex,
      borderRadius: s.radius ? `${s.radius}px` : "0px",
      shadow: s.shadow || null,
      // Debug: original color values before hex conversion
      originalBackgroundColor: s.colors.background || undefined,
      originalTextColor: s.colors.text || undefined,
      originalBorderColor: s.colors.border || undefined,
    };
  });

  return {
    colorScheme: raw.colorScheme,
    fonts: fontsList,
    colors: palette,
    typography,
    spacing: {
      baseUnit: baseUnit,
      borderRadius: borderRadius,
    },
    components,
    images,
    __button_snapshots: buttonSnapshots as any,
    __framework_hints: raw.frameworkHints as any,
  };
}
