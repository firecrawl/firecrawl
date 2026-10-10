import { CONSTANTS } from "./constants";
import {
  getClassNameString,
  getComputedStyleCached,
  getPseudoStyle,
  recordError,
} from "./helpers";

const isOpaque = (color: string | null | undefined): boolean => {
  if (!color || color === "transparent") return false;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return true;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
  return alpha > CONSTANTS.MIN_ALPHA_THRESHOLD;
};

/** Rendered, with a size, and not hidden or fully transparent. */
export const isVisibleElement = (el: Element, rect: DOMRect): boolean => {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const cs = getComputedStyleCached(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  return !(parseFloat(cs.opacity) < 0.05);
};

/** The first opaque background behind an element (its ancestors'), white if none. */
const getBackgroundBehind = (el: Element): string => {
  let parent = el.parentElement;
  for (let depth = 0; parent && depth < 10; depth++) {
    const bg = getComputedStyleCached(parent).backgroundColor;
    if (isOpaque(bg)) return bg;
    parent = parent.parentElement;
  }
  return "rgb(255, 255, 255)";
};

/**
 * The color filling a button-like element as a visitor sees it: its own
 * background, else a ::before/::after layer, else a child covering most of it.
 * Many buttons are a transparent <a> or <button> with the fill on an inner
 * span or a pseudo-element. Null when nothing fills it.
 */
export const getEffectiveFill = (el: Element): string | null => {
  try {
    const own = getComputedStyleCached(el).backgroundColor;
    if (isOpaque(own)) return own;
    for (const pseudo of ["::before", "::after"]) {
      const ps = getPseudoStyle(el, pseudo);
      if (
        ps &&
        ps.content &&
        ps.content !== "none" &&
        isOpaque(ps.backgroundColor)
      ) {
        return ps.backgroundColor;
      }
    }
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > 0) {
      for (let i = 0; i < el.children.length && i < 5; i++) {
        const child = el.children[i];
        const r = child.getBoundingClientRect();
        if (r.width * r.height >= area * 0.8) {
          const bg = getComputedStyleCached(child).backgroundColor;
          if (isOpaque(bg)) return bg;
        }
      }
    }
  } catch (e) {
    recordError("getEffectiveFill", e);
  }
  return null;
};

/** Filled with a color that stands out from what is behind it, or outlined. */
export const looksFilledOrOutlined = (el: Element): boolean => {
  const fill = getEffectiveFill(el);
  if (fill && fill !== getBackgroundBehind(el)) return true;
  const cs = getComputedStyleCached(el);
  return parseFloat(cs.borderTopWidth) > 0 && isOpaque(cs.borderTopColor);
};

export const checkButtonLikeElement = (
  el: Element,
  cs: CSSStyleDeclaration,
  rect: DOMRect,
  classNames: string,
): boolean => {
  const hasButtonClasses = CONSTANTS.BUTTON_CLASS_PATTERN.test(classNames);

  if (
    hasButtonClasses &&
    rect.width > CONSTANTS.BUTTON_MIN_WIDTH &&
    rect.height > CONSTANTS.BUTTON_MIN_HEIGHT
  ) {
    return true;
  }

  const paddingTop = parseFloat(cs.paddingTop) || 0;
  const paddingBottom = parseFloat(cs.paddingBottom) || 0;
  const paddingLeft = parseFloat(cs.paddingLeft) || 0;
  const paddingRight = parseFloat(cs.paddingRight) || 0;
  const hasPadding =
    paddingTop > CONSTANTS.BUTTON_MIN_PADDING_VERTICAL ||
    paddingBottom > CONSTANTS.BUTTON_MIN_PADDING_VERTICAL ||
    paddingLeft > CONSTANTS.BUTTON_MIN_PADDING_HORIZONTAL ||
    paddingRight > CONSTANTS.BUTTON_MIN_PADDING_HORIZONTAL;
  const hasMinSize =
    rect.width > CONSTANTS.BUTTON_MIN_WIDTH &&
    rect.height > CONSTANTS.BUTTON_MIN_HEIGHT;
  const hasRounded = parseFloat(cs.borderRadius) > 0;
  const hasBorder =
    parseFloat(cs.borderTopWidth) > 0 ||
    parseFloat(cs.borderBottomWidth) > 0 ||
    parseFloat(cs.borderLeftWidth) > 0 ||
    parseFloat(cs.borderRightWidth) > 0;

  if (hasPadding && hasMinSize && (hasRounded || hasBorder)) return true;

  // Links styled through an inner span or a pseudo-element have no padding or
  // border of their own; what makes them a button is a fill that stands out.
  return hasMinSize && looksFilledOrOutlined(el);
};

export const isButtonElement = (el: Element | null): boolean => {
  if (!el || typeof el.matches !== "function") return false;

  if (el.matches(CONSTANTS.BUTTON_SELECTOR)) {
    return true;
  }

  if (el.tagName.toLowerCase() === "a") {
    try {
      const classNames = getClassNameString(el).toLowerCase();
      const cs = getComputedStyleCached(el);
      const rect = el.getBoundingClientRect();
      return checkButtonLikeElement(el, cs, rect, classNames);
    } catch (e) {
      recordError("isButtonElement", e);
      return false;
    }
  }

  return false;
};
