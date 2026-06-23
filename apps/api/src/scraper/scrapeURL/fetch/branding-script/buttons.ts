import { CONSTANTS } from "./constants";
import {
  getClassNameString,
  getComputedStyleCached,
  recordError,
} from "./helpers";

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

  return hasPadding && hasMinSize && (hasRounded || hasBorder);
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
