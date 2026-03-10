import { CONSTANTS } from "./constants";
import { getComputedStyleCached } from "./helpers";

export interface Typography {
  stacks: {
    body: string[];
    heading: string[];
    paragraph: string[];
  };
  sizes: {
    h1: string;
    h2: string;
    body: string;
  };
}

export const getTypography = (): Typography => {
  const pickFontStack = (el: Element): string[] => {
    return (
      getComputedStyleCached(el)
        .fontFamily?.split(",")
        .map(f => f.replace(/["']/g, "").trim())
        .filter(Boolean) || []
    );
  };

  // Fallback to documentElement when body is null (e.g. incomplete or non-HTML doc)
  const bodyOrRoot =
    document.body ?? (document.documentElement as unknown as Element);
  const h1 = document.querySelector("h1") ?? bodyOrRoot;
  const h2 = document.querySelector("h2") ?? h1;
  const p = document.querySelector("p") ?? bodyOrRoot;
  const body = bodyOrRoot;

  return {
    stacks: {
      body: pickFontStack(body),
      heading: pickFontStack(h1),
      paragraph: pickFontStack(p),
    },
    sizes: {
      h1: getComputedStyleCached(h1).fontSize || "32px",
      h2: getComputedStyleCached(h2).fontSize || "24px",
      body: getComputedStyleCached(p).fontSize || "16px",
    },
  };
};

export const detectFrameworkHints = (): string[] => {
  const hints: string[] = [];

  const generator = document.querySelector('meta[name="generator"]');
  if (generator) hints.push(generator.getAttribute("content") || "");

  const scripts = Array.from(document.querySelectorAll("script[src]"))
    .map(s => s.getAttribute("src") || "")
    .filter(Boolean);

  if (
    scripts.some(s => s.includes("tailwind") || s.includes("cdn.tailwindcss"))
  ) {
    hints.push("tailwind");
  }
  if (scripts.some(s => s.includes("bootstrap"))) {
    hints.push("bootstrap");
  }
  if (scripts.some(s => s.includes("mui") || s.includes("material-ui"))) {
    hints.push("material-ui");
  }

  return hints.filter(Boolean);
};

export const detectColorScheme = (): "dark" | "light" => {
  const body = document.body;
  const html = document.documentElement;

  const hasDarkIndicator =
    html.classList.contains("dark") ||
    body.classList.contains("dark") ||
    html.classList.contains("dark-mode") ||
    body.classList.contains("dark-mode") ||
    html.getAttribute("data-theme") === "dark" ||
    body.getAttribute("data-theme") === "dark" ||
    html.getAttribute("data-bs-theme") === "dark";

  const hasLightIndicator =
    html.classList.contains("light") ||
    body.classList.contains("light") ||
    html.classList.contains("light-mode") ||
    body.classList.contains("light-mode") ||
    html.getAttribute("data-theme") === "light" ||
    body.getAttribute("data-theme") === "light" ||
    html.getAttribute("data-bs-theme") === "light";

  let prefersDark = false;
  try {
    prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    // matchMedia not available
  }

  if (hasDarkIndicator) return "dark";
  if (hasLightIndicator) return "light";

  const getEffectiveBackground = (
    el: Element,
  ): { r: number; g: number; b: number; alpha: number } | null => {
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 10) {
      const bg = getComputedStyleCached(current).backgroundColor;
      const match = bg.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
      );
      if (match) {
        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);
        const alpha = match[4] ? parseFloat(match[4]) : 1;

        if (alpha > CONSTANTS.MIN_ALPHA_THRESHOLD) {
          return { r, g, b, alpha };
        }
      }
      current = current.parentElement;
      depth++;
    }
    return null;
  };

  const bodyBg = getEffectiveBackground(body);
  const htmlBg = getEffectiveBackground(html);
  const effectiveBg = bodyBg || htmlBg;

  if (effectiveBg) {
    const { r, g, b } = effectiveBg;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

    if (luminance < 0.4) return "dark";
    if (luminance > 0.6) return "light";

    return prefersDark ? "dark" : "light";
  }

  return prefersDark ? "dark" : "light";
};

export const extractBrandName = (): string => {
  const ogSiteName = document
    .querySelector('meta[property="og:site_name"]')
    ?.getAttribute("content");
  const title = document.title;
  const h1 = document.querySelector("h1")?.textContent?.trim();

  let domainName = "";
  try {
    const hostname = window.location.hostname;
    domainName = hostname.replace(/^www\./, "").split(".")[0];
    domainName = domainName.charAt(0).toUpperCase() + domainName.slice(1);
  } catch (e) {
    // location not available
  }

  let titleBrand = "";
  if (title) {
    titleBrand = title
      .replace(/\s*[-|–|—]\s*.*$/, "")
      .replace(/\s*:\s*.*$/, "")
      .replace(/\s*\|.*$/, "")
      .trim();
  }

  return ogSiteName || titleBrand || h1 || domainName || "";
};

export const normalizeColor = (
  color: string | null | undefined,
): string | null => {
  if (!color || typeof color !== "string") return null;
  const normalized = color.toLowerCase().trim();

  if (normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") {
    return null;
  }

  if (
    normalized === "#ffffff" ||
    normalized === "#fff" ||
    normalized === "white" ||
    normalized === "rgb(255, 255, 255)" ||
    /^rgba\(255,\s*255,\s*255(,\s*1(\.0)?)?\)$/.test(normalized)
  ) {
    return "rgb(255, 255, 255)";
  }

  if (
    normalized === "#000000" ||
    normalized === "#000" ||
    normalized === "black" ||
    normalized === "rgb(0, 0, 0)" ||
    /^rgba\(0,\s*0,\s*0(,\s*1(\.0)?)?\)$/.test(normalized)
  ) {
    return "rgb(0, 0, 0)";
  }

  if (normalized.startsWith("#")) {
    return normalized;
  }

  if (normalized.startsWith("rgb")) {
    return normalized.replace(/\s+/g, "");
  }

  return normalized;
};

export const isValidBackgroundColor = (
  color: string | null | undefined,
): boolean => {
  if (!color || typeof color !== "string") return false;
  const normalized = color.toLowerCase().trim();
  if (normalized === "transparent" || normalized === "rgba(0, 0, 0, 0)") {
    return false;
  }
  const rgbaMatch = normalized.match(
    /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/,
  );
  if (rgbaMatch) {
    const alpha = parseFloat(rgbaMatch[1]);
    if (alpha < CONSTANTS.MAX_TRANSPARENT_ALPHA) {
      return false;
    }
    return true;
  }
  const colorMatch = normalized.match(/color\([^)]+\)/);
  if (colorMatch) {
    return true;
  }
  return normalized.length > 0;
};

export interface BackgroundCandidate {
  color: string;
  source: string;
  priority: number;
  area?: number;
}

export const getBackgroundCandidates = (): BackgroundCandidate[] => {
  const candidates: BackgroundCandidate[] = [];

  const colorFrequency = new Map<string, number>();
  const allSampleElements = document.querySelectorAll(
    "body, html, main, article, [role='main'], div, section",
  );
  const sampleEls = Array.from(allSampleElements).slice(
    0,
    CONSTANTS.MAX_BACKGROUND_SAMPLES,
  );

  sampleEls.forEach(el => {
    try {
      const bg = getComputedStyleCached(el).backgroundColor;
      if (isValidBackgroundColor(bg)) {
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > CONSTANTS.MIN_SIGNIFICANT_AREA) {
          const normalized = normalizeColor(bg);
          if (normalized) {
            const currentCount = colorFrequency.get(normalized) || 0;
            colorFrequency.set(normalized, currentCount + area);
          }
        }
      }
    } catch (e) {
      // Ignore element errors
    }
  });

  let mostCommonColor: string | null = null;
  let maxArea = 0;
  Array.from(colorFrequency.entries()).forEach(([color, area]) => {
    if (area > maxArea) {
      maxArea = area;
      mostCommonColor = color;
    }
  });

  const bodyBg = getComputedStyleCached(document.body).backgroundColor;
  const htmlBg = getComputedStyleCached(
    document.documentElement,
  ).backgroundColor;

  if (isValidBackgroundColor(bodyBg)) {
    const normalized = normalizeColor(bodyBg);
    const priority = normalized === mostCommonColor ? 15 : 10;
    if (normalized) {
      candidates.push({
        color: normalized,
        source: "body",
        priority: priority,
      });
    }
  }

  if (isValidBackgroundColor(htmlBg)) {
    const normalized = normalizeColor(htmlBg);
    const priority = normalized === mostCommonColor ? 14 : 9;
    if (normalized) {
      candidates.push({
        color: normalized,
        source: "html",
        priority: priority,
      });
    }
  }

  const normalizedBodyBg = normalizeColor(bodyBg);
  const normalizedHtmlBg = normalizeColor(htmlBg);
  if (
    mostCommonColor &&
    mostCommonColor !== normalizedBodyBg &&
    mostCommonColor !== normalizedHtmlBg
  ) {
    candidates.push({
      color: mostCommonColor,
      source: "most-common-visible",
      priority: 12,
      area: maxArea,
    });
  }

  try {
    const rootStyle = getComputedStyleCached(document.documentElement);

    const cssVars = [
      "--background",
      "--background-light",
      "--background-dark",
      "--bg-background",
      "--bg-background-light",
      "--bg-background-dark",
      "--color-background",
      "--color-background-light",
      "--color-background-dark",
    ];

    cssVars.forEach(varName => {
      try {
        const rawValue = rootStyle.getPropertyValue(varName).trim();

        if (rawValue && isValidBackgroundColor(rawValue)) {
          candidates.push({
            color: rawValue,
            source: "css-var:" + varName,
            priority: 8,
          });
        }
      } catch (e) {
        // Ignore CSS var errors
      }
    });
  } catch (e) {
    // Ignore root style errors
  }

  try {
    const allContainers = document.querySelectorAll(
      "main, article, [role='main'], header, .main, .container",
    );
    const mainContainers = Array.from(allContainers).slice(0, 5);
    mainContainers.forEach(el => {
      try {
        const bg = getComputedStyleCached(el).backgroundColor;
        if (isValidBackgroundColor(bg)) {
          const rect = el.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area > CONSTANTS.MIN_LARGE_CONTAINER_AREA) {
            const normalized = normalizeColor(bg);
            if (normalized) {
              candidates.push({
                color: normalized,
                source: el.tagName.toLowerCase() + "-container",
                priority: 5,
                area: area,
              });
            }
          }
        }
      } catch (e) {
        // Ignore container errors
      }
    });
  } catch (e) {
    // Ignore container query errors
  }

  const seen = new Set<string>();
  const unique = candidates.filter(c => {
    if (!c || !c.color) return false;
    const key = normalizeColor(c.color);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  return unique;
};
