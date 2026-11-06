import { LogoCandidate } from "./logo-selector";

/**
 * Fallback logo from site-declared brand marks, used only when the normal
 * candidate → heuristic → LLM pipeline produced no logo. JSON-LD `logo` is
 * the site explicitly naming its logo; the largest apple-touch icon is a
 * square brand mark by platform convention.
 */
export function pickDeclaredLogo(
  images: Array<{ type: string; src: string }> | undefined,
): { src: string; source: "logo-jsonld" | "apple-touch-icon" } | null {
  if (!images) return null;
  const jsonld = images.find(i => i.type === "logo-jsonld" && i.src);
  if (jsonld) return { src: jsonld.src, source: "logo-jsonld" };
  const touch = images.find(i => i.type === "apple-touch-icon" && i.src);
  if (touch) return { src: touch.src, source: "apple-touch-icon" };
  return null;
}

type DeclaredRaceCandidate = Pick<
  LogoCandidate,
  "src" | "isVisible" | "location" | "indicators"
>;

function hasLogoMark(c: DeclaredRaceCandidate): boolean {
  const { altMatch, srcMatch, classMatch } = c.indicators;
  return altMatch || srcMatch || classMatch;
}

function hasStrongVisibleHeaderLogo(c: DeclaredRaceCandidate): boolean {
  if (!c.isVisible) return false;
  if (!(c.location === "header" || c.indicators.inHeader)) return false;
  return hasLogoMark(c) || c.indicators.hrefMatch;
}

/**
 * Inject a declared mark only when the rendered candidates don't already hold
 * the logo. The site names its own logo in JSON-LD, so that mark competes
 * unless a strong header logo is in the race; an apple-touch icon is just the
 * app icon, so anything visible that looks like a logo (alt, src or class
 * says so) keeps it out, wherever on the page it sits.
 */
export function shouldAddDeclaredLogoCandidate(
  existing: DeclaredRaceCandidate[],
  declared: { src: string; source: "logo-jsonld" | "apple-touch-icon" },
): boolean {
  if (existing.some(c => c.src === declared.src && c.isVisible)) return false;
  if (declared.source === "apple-touch-icon") {
    return !existing.some(c => c.isVisible && hasLogoMark(c));
  }
  return !existing.some(hasStrongVisibleHeaderLogo);
}

/** Turn a declared mark into a logo candidate so it can win selection, not only last-resort fallback. */
export function declaredLogoCandidate(
  src: string,
  source: "logo-jsonld" | "apple-touch-icon",
  brandName?: string,
): LogoCandidate {
  const isSvg =
    /\.svg(\?|#|$)/i.test(src) ||
    src.toLowerCase().startsWith("data:image/svg");
  return {
    src,
    alt: brandName?.trim() || "",
    isSvg,
    isVisible: true,
    location: "header",
    position: { top: 0, left: 0, width: 180, height: 180 },
    indicators: {
      inHeader: true,
      altMatch: false,
      srcMatch: true,
      classMatch: false,
      hrefMatch: true,
    },
    source,
  };
}
