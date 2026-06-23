import { CONSTANTS } from "./constants";
import {
  getClassNameString,
  getComputedStyleCached,
  recordError,
  toPx,
} from "./helpers";
import { isButtonElement } from "./buttons";

export const sampleElements = (): Element[] => {
  const picksSet = new Set<Element>();

  const pushQ = (q: string, limit = 10) => {
    const elements = Array.from(document.querySelectorAll(q));
    let count = 0;
    for (const el of elements) {
      if (count >= limit) break;
      picksSet.add(el);
      count++;
    }
  };

  pushQ('header img, .site-logo img, img[alt*=logo i], img[src*="logo"]', 5);

  pushQ(
    'button, input[type="submit"], input[type="button"], [role=button], [data-primary-button], [data-secondary-button], [data-cta], a.button, a.btn, [class*="btn"], [class*="button"], a[class*="bg-brand"], a[class*="bg-primary"], a[class*="bg-accent"]',
    100,
  );

  const allLinks = Array.from(document.querySelectorAll("a")).slice(0, 100);
  for (const link of allLinks) {
    if (!picksSet.has(link) && isButtonElement(link)) {
      picksSet.add(link);
    }
  }

  pushQ('input, select, textarea, [class*="form-control"]', 25);
  pushQ("h1, h2, h3, p, a", 50);

  // Avoid Array.from on Set - old mootools overwrites Array.from and breaks Set iteration
  const result: Element[] = [];
  picksSet.forEach(el => result.push(el));

  return result.filter(Boolean);
};

export interface StyleSnapshot {
  tag: string;
  classes: string;
  text: string;
  rect: { w: number; h: number };
  colors: {
    text: string;
    background: string;
    border: string;
    borderWidth: number | null;
    borderTop: string;
    borderTopWidth: number | null;
    borderRight: string;
    borderRightWidth: number | null;
    borderBottom: string;
    borderBottomWidth: number | null;
    borderLeft: string;
    borderLeftWidth: number | null;
  };
  typography: {
    fontStack: string[];
    size: string | null;
    weight: number | null;
  };
  radius: number | null;
  borderRadius: {
    topLeft: number | null;
    topRight: number | null;
    bottomRight: number | null;
    bottomLeft: number | null;
  };
  shadow: string | null;
  isButton: boolean;
  isNavigation: boolean;
  hasCTAIndicator: boolean;
  isInput: boolean;
  inputMetadata: InputMetadata | null;
  isLink: boolean;
}

interface InputMetadata {
  type: string;
  placeholder: string;
  value: string;
  required: boolean;
  disabled: boolean;
  name: string;
  id: string;
  label: string;
}

export const getStyleSnapshot = (el: Element): StyleSnapshot => {
  const cs = getComputedStyleCached(el);
  const rect = el.getBoundingClientRect();

  const fontStack =
    cs
      .getPropertyValue("font-family")
      ?.split(",")
      .map(f => f.replace(/["']/g, "").trim())
      .filter(Boolean) || [];

  let classNames = "";
  try {
    if (el.getAttribute) {
      const attrClass = el.getAttribute("class");
      if (attrClass) classNames = attrClass.toLowerCase();
    }
    if (!classNames) {
      classNames = getClassNameString(el).toLowerCase();
    }
  } catch (e) {
    try {
      classNames = getClassNameString(el).toLowerCase();
    } catch (e2) {
      classNames = "";
    }
  }

  let bgColor = cs.getPropertyValue("background-color");
  const textColor = cs.getPropertyValue("color");

  const isTransparent =
    bgColor === "transparent" || bgColor === "rgba(0, 0, 0, 0)";
  const alphaMatch = bgColor.match(/rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/);
  const hasZeroAlpha = alphaMatch && parseFloat(alphaMatch[1]) === 0;

  const isInputElement =
    el.tagName.toLowerCase() === "input" ||
    el.tagName.toLowerCase() === "select" ||
    el.tagName.toLowerCase() === "textarea";

  if ((isTransparent || hasZeroAlpha) && !isInputElement) {
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < CONSTANTS.MAX_PARENT_TRAVERSAL) {
      const parentBg =
        getComputedStyleCached(parent).getPropertyValue("background-color");
      if (
        parentBg &&
        parentBg !== "transparent" &&
        parentBg !== "rgba(0, 0, 0, 0)"
      ) {
        const parentAlphaMatch = parentBg.match(
          /rgba?\([^,]*,[^,]*,[^,]*,\s*([\d.]+)\)/,
        );
        const parentAlpha = parentAlphaMatch
          ? parseFloat(parentAlphaMatch[1])
          : 1;
        if (parentAlpha > CONSTANTS.MIN_ALPHA_THRESHOLD) {
          bgColor = parentBg;
          break;
        }
      }
      parent = parent.parentElement;
      depth++;
    }
  }

  const isButton = isButtonElement(el);

  let isNavigation = false;
  let hasCTAIndicator = false;

  try {
    hasCTAIndicator =
      el.matches(
        '[data-primary-button],[data-secondary-button],[data-cta],[class*="cta"],[class*="hero"]',
      ) ||
      el.getAttribute("data-primary-button") === "true" ||
      el.getAttribute("data-secondary-button") === "true";

    if (!hasCTAIndicator) {
      const hasNavClass =
        classNames.includes("nav-") ||
        classNames.includes("-nav") ||
        classNames.includes("nav-anchor") ||
        classNames.includes("nav-link") ||
        classNames.includes("sidebar-") ||
        classNames.includes("-sidebar") ||
        classNames.includes("menu-") ||
        classNames.includes("-menu") ||
        classNames.includes("toggle") ||
        classNames.includes("trigger");

      const hasNavRole = el.matches(
        '[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[aria-haspopup],[aria-expanded]',
      );

      const inNavContext = !!el.closest(
        'nav, [role="navigation"], [role="menu"], [role="menubar"], [class*="navigation"], [class*="dropdown"], [class*="sidebar"], [id*="sidebar"], [id*="navigation"], [id*="nav-"], aside[class*="nav"], aside[id*="nav"]',
      );

      let isNavLink = false;
      if (el.tagName.toLowerCase() === "a" && el.parentElement) {
        if (el.parentElement.tagName.toLowerCase() === "li") {
          const listEl = el.closest("ul, ol");
          if (
            listEl &&
            listEl.closest(
              '[class*="nav"], [id*="nav"], [class*="sidebar"], [id*="sidebar"]',
            )
          ) {
            isNavLink = true;
          }
        }
      }

      isNavigation = hasNavClass || hasNavRole || inNavContext || isNavLink;
    }
  } catch (e) {
    recordError("getStyleSnapshot-navigation-detection", e);
  }

  let text = "";
  const inputEl = el as HTMLInputElement;
  if (
    el.tagName.toLowerCase() === "input" &&
    (inputEl.type === "submit" || inputEl.type === "button")
  ) {
    text = (inputEl.value && inputEl.value.trim().substring(0, 100)) || "";
  } else {
    text = (el.textContent && el.textContent.trim().substring(0, 100)) || "";
  }

  const isInputField = el.matches(
    'input:not([type="submit"]):not([type="button"]),select,textarea,[class*="form-control"]',
  );
  let inputMetadata: InputMetadata | null = null;
  if (isInputField) {
    const tagName = el.tagName.toLowerCase();
    const inp = el as HTMLInputElement;
    inputMetadata = {
      type: tagName === "input" ? inp.type || "text" : tagName,
      placeholder: inp.placeholder || "",
      value: tagName === "input" ? inp.value || "" : "",
      required: inp.required || false,
      disabled: inp.disabled || false,
      name: inp.name || "",
      id: el.id || "",
      label: (() => {
        if (el.id) {
          const label = document.querySelector(
            'label[for="' + CSS.escape(el.id) + '"]',
          );
          if (label) return (label.textContent || "").trim().substring(0, 100);
        }
        const parentLabel = el.closest("label");
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true) as HTMLElement;
          const inputInClone = clone.querySelector("input,select,textarea");
          if (inputInClone) inputInClone.remove();
          return (clone.textContent || "").trim().substring(0, 100);
        }
        return "";
      })(),
    };
  }

  return {
    tag: el.tagName.toLowerCase(),
    classes: classNames,
    text: text,
    rect: { w: rect.width, h: rect.height },
    colors: {
      text: textColor,
      background: bgColor,
      border: (() => {
        const top = cs.getPropertyValue("border-top-color");
        const right = cs.getPropertyValue("border-right-color");
        const bottom = cs.getPropertyValue("border-bottom-color");
        const left = cs.getPropertyValue("border-left-color");
        if (top === right && top === bottom && top === left) return top;
        return top;
      })(),
      borderWidth: (() => {
        const top = toPx(cs.getPropertyValue("border-top-width"));
        const right = toPx(cs.getPropertyValue("border-right-width"));
        const bottom = toPx(cs.getPropertyValue("border-bottom-width"));
        const left = toPx(cs.getPropertyValue("border-left-width"));
        if (top === right && top === bottom && top === left) return top;
        return top;
      })(),
      borderTop: cs.getPropertyValue("border-top-color"),
      borderTopWidth: toPx(cs.getPropertyValue("border-top-width")),
      borderRight: cs.getPropertyValue("border-right-color"),
      borderRightWidth: toPx(cs.getPropertyValue("border-right-width")),
      borderBottom: cs.getPropertyValue("border-bottom-color"),
      borderBottomWidth: toPx(cs.getPropertyValue("border-bottom-width")),
      borderLeft: cs.getPropertyValue("border-left-color"),
      borderLeftWidth: toPx(cs.getPropertyValue("border-left-width")),
    },
    typography: {
      fontStack,
      size: cs.getPropertyValue("font-size") || null,
      weight: parseInt(cs.getPropertyValue("font-weight"), 10) || null,
    },
    radius: toPx(cs.getPropertyValue("border-radius")),
    borderRadius: {
      topLeft: toPx(cs.getPropertyValue("border-top-left-radius")),
      topRight: toPx(cs.getPropertyValue("border-top-right-radius")),
      bottomRight: toPx(cs.getPropertyValue("border-bottom-right-radius")),
      bottomLeft: toPx(cs.getPropertyValue("border-bottom-left-radius")),
    },
    shadow: cs.getPropertyValue("box-shadow") || null,
    isButton: isButton && !isNavigation,
    isNavigation: isNavigation,
    hasCTAIndicator: hasCTAIndicator,
    isInput: isInputField,
    inputMetadata: inputMetadata,
    isLink: el.matches("a"),
  };
};
