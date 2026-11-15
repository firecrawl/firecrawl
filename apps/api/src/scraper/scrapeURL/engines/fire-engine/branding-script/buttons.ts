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

// Classes site builders and reveal scripts put on content that is faded out
// only until it scrolls into view (Elementor, WOW.js, AOS, animate.css, the
// "js-reveal" convention), and attributes that mark the same thing.
const ENTRANCE_CLASS =
  /(?:^|\s)(?:elementor-invisible|wow|aos-init|animate__animated|[\w-]*reveal[\w-]*|[\w-]*fade-?in[\w-]*)(?:\s|$)/i;
const ENTRANCE_ATTRS = ["data-aos", "data-framer-appear-id", "data-motion-enter"];

/**
 * An element at opacity 0 (or visibility hidden) that is only waiting for its
 * entrance animation: in normal flow, not a dismissed overlay, and either
 * animated by CSS, slid out of place by a motion script (inline opacity 0 with
 * a translate), or tagged with a reveal class or attribute. A closed menu,
 * accordion or dialog is absolutely or fixed positioned, display none, or
 * aria-hidden, and none of these say it will appear. A transition alone is
 * not proof either: a closed accordion fades too, so it needs a marker.
 */
const isAppearing = (node: Element, cs: CSSStyleDeclaration): boolean => {
  if (cs.display === "none") return false;
  if (
    node.getAttribute("aria-hidden") === "true" ||
    node.hasAttribute("hidden") ||
    node.hasAttribute("inert")
  ) {
    return false;
  }
  const position = cs.position;
  if (position === "fixed" || position === "absolute") return false;
  if (cs.pointerEvents === "none") return false;

  const animation = cs.getPropertyValue("animation-name");
  if (animation && animation !== "none") return true;
  const inline = (node.getAttribute("style") || "").toLowerCase();
  if (
    /opacity:\s*0(?:[;\s]|$)/.test(inline) &&
    /transform:\s*[^;]*translate/.test(inline)
  ) {
    return true;
  }
  const className = node.getAttribute("class") || "";
  if (ENTRANCE_CLASS.test(className)) return true;
  return ENTRANCE_ATTRS.some(attr => node.hasAttribute(attr));
};

/**
 * Rendered, with a size, and not hidden or fully transparent. Opacity doesn't
 * inherit, so a faded-out ancestor (a closed menu) is checked too. Two kinds
 * of transparency don't count: the page itself at opacity 0 (a load-time fade
 * on html or body that headless rendering never finishes), and content faded
 * out only until it scrolls into view, which the scan's tall window never
 * triggers. Visitors see both.
 */
export const isVisibleElement = (el: Element, rect: DOMRect): boolean => {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const cs = getComputedStyleCached(el);
  if (cs.display === "none") return false;
  // visibility inherits: `el` reads hidden when any ancestor is. Each
  // ancestor that sets it (hidden while its own parent is not) must be
  // waiting on an entrance animation, as with Elementor's
  // elementor-invisible; one that merely inherits is not judged, and one
  // closed for good hides `el` whatever sits between them.
  const checkVisibility = cs.visibility === "hidden";
  let node: Element | null = el;
  for (let depth = 0; node && depth < 15; depth++) {
    const nodeStyle = getComputedStyleCached(node);
    if (nodeStyle.display === "none") return false;
    if (checkVisibility && nodeStyle.visibility === "hidden") {
      const parent = node.parentElement;
      const setsIt =
        !parent || getComputedStyleCached(parent).visibility !== "hidden";
      if (setsIt && !isAppearing(node, nodeStyle)) return false;
    }
    if (parseFloat(nodeStyle.opacity) < 0.05) {
      const isPage =
        node === document.documentElement || node === document.body;
      if (!isPage && !isAppearing(node, nodeStyle)) return false;
    }
    node = node.parentElement;
  }
  return true;
};

/** Fixed or sticky (itself or an ancestor): its on-screen position doesn't scroll. */
export const isViewportAnchored = (el: Element): boolean => {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 10; depth++) {
    const position = getComputedStyleCached(node).position;
    if (position === "fixed" || position === "sticky") return true;
    node = node.parentElement;
  }
  return false;
};

// In a window much taller than a screen, anything sized to the window
// stretches with it. Positions are then reported as they would be on a screen
// of this height.
const SCREEN_PX = 1080;
const isTallWindow = (): boolean => window.innerHeight > 10 * SCREEN_PX;

type ScreenBlock = { top: number; height: number };
let screenBlocks: ScreenBlock[] | null = null;

/** The outermost elements sized to the window: on a real screen, one screen tall. */
const getScreenBlocks = (): ScreenBlock[] => {
  if (screenBlocks) return screenBlocks;
  const windowHeight = window.innerHeight;
  const blocks: ScreenBlock[] = [];
  const queue: Element[] = document.body
    ? Array.from(document.body.children)
    : [];
  // Only elements at least half the window tall can contain a block.
  for (let i = 0; i < queue.length && i < 2000; i++) {
    const rect = queue[i].getBoundingClientRect();
    if (rect.height < windowHeight / 2) continue;
    if (rect.height <= windowHeight * 1.01) {
      blocks.push({
        top: rect.top + (window.scrollY || 0),
        height: rect.height,
      });
    } else {
      queue.push(...Array.from(queue[i].children));
    }
  }
  screenBlocks = blocks.sort((a, b) => a.top - b.top);
  return screenBlocks;
};

/**
 * An offset within something as tall as the window. Offsets set in pixels
 * (normal flow, `top: 80px`) are kept; offsets that come from the window's
 * height (centered, pinned to the bottom) scale with it.
 */
const toScreenOffset = (offset: number): number =>
  offset < 0.3 * window.innerHeight
    ? offset
    : (offset * SCREEN_PX) / window.innerHeight;

/** A page position in a tall window, mapped to a page of real screens. */
const toScreenPosition = (top: number): number => {
  const scale = SCREEN_PX / window.innerHeight;
  let removed = 0;
  let end = -Infinity;
  for (const block of getScreenBlocks()) {
    if (block.top < end) continue; // inside an earlier block
    end = block.top + block.height;
    if (top < block.top) break;
    if (top < end) {
      return block.top - removed + toScreenOffset(top - block.top);
    }
    removed += block.height * (1 - scale);
  }
  return top - removed;
};

/** Distance from the top of the page, or of the screen for fixed/sticky elements. */
export const pageTop = (el: Element, rect: DOMRect): number => {
  if (isViewportAnchored(el)) {
    return isTallWindow() ? toScreenOffset(rect.top) : rect.top;
  }
  const top = rect.top + (window.scrollY || 0);
  return isTallWindow() ? toScreenPosition(top) : top;
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
      // Hover-only layers sit at opacity 0 until hovered: not a fill.
      if (
        ps &&
        ps.content &&
        ps.content !== "none" &&
        ps.visibility !== "hidden" &&
        !(parseFloat(ps.opacity) < 0.05) &&
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
