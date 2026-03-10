import { getComputedStyleCached } from "./helpers";

const FC_IDX = "data-fc-idx";

export const resolveSvgUseElements = (
  svgClone: SVGSVGElement,
  originalSvg: SVGSVGElement,
): SVGSVGElement => {
  const useElements = Array.from(svgClone.querySelectorAll("use"));

  for (const useEl of useElements) {
    const href = useEl.getAttribute("href") || useEl.getAttribute("xlink:href");
    if (!href) continue;

    const idMatch = href.match(/#([^)]+)/);
    if (!idMatch) continue;

    const targetId = idMatch[1];

    let referencedEl: Element | null = originalSvg.querySelector(
      "#" + CSS.escape(targetId),
    );

    if (!referencedEl) {
      let parent = originalSvg.parentElement;
      while (parent && !referencedEl) {
        if (parent.tagName === "svg" || parent.tagName === "SVG") {
          referencedEl = parent.querySelector("#" + CSS.escape(targetId));
        }
        parent = parent.parentElement;
      }
    }

    if (!referencedEl) {
      referencedEl = document.getElementById(targetId);
    }

    if (referencedEl && useEl.parentNode) {
      const clonedRef = referencedEl.cloneNode(true) as Element;
      const useIdx = useEl.getAttribute(FC_IDX);

      if (clonedRef.tagName === "symbol" || clonedRef.tagName === "SYMBOL") {
        const wrapper = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );

        const viewBox = clonedRef.getAttribute("viewBox");
        if (viewBox) wrapper.setAttribute("viewBox", viewBox);
        const preserveAspectRatio = clonedRef.getAttribute(
          "preserveAspectRatio",
        );
        if (preserveAspectRatio)
          wrapper.setAttribute("preserveAspectRatio", preserveAspectRatio);

        Array.from(useEl.attributes).forEach(attr => {
          if (attr.name !== "href" && attr.name !== "xlink:href") {
            wrapper.setAttribute(attr.name, attr.value);
          }
        });

        if (useIdx != null) wrapper.setAttribute(FC_IDX, useIdx);

        while (clonedRef.firstChild) {
          wrapper.appendChild(clonedRef.firstChild);
        }

        useEl.parentNode.replaceChild(wrapper, useEl);
      } else {
        const clonedContent = clonedRef.cloneNode(true) as Element;

        Array.from(useEl.attributes).forEach(attr => {
          if (attr.name !== "href" && attr.name !== "xlink:href") {
            if (clonedContent.setAttribute) {
              clonedContent.setAttribute(attr.name, attr.value);
            }
          }
        });

        if (useIdx != null) clonedContent.setAttribute(FC_IDX, useIdx);

        useEl.parentNode.replaceChild(clonedContent, useEl);
      }
    }
  }

  return svgClone;
};

export const resolveSvgStyles = (svg: SVGSVGElement): SVGSVGElement => {
  const svgClone = svg.cloneNode(true) as SVGSVGElement;

  // Build aligned element lists *before* resolving <use>, so indices stay 1:1.
  const originalElements = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const clonedElementsPre = [
    svgClone,
    ...Array.from(svgClone.querySelectorAll("*")),
  ];
  clonedElementsPre.forEach((el, i) => el.setAttribute(FC_IDX, String(i)));

  const svgWithResolvedUse = resolveSvgUseElements(svgClone, svg);

  const computedStyles = originalElements.map(el => ({
    el,
    computed: getComputedStyleCached(el),
  }));

  const svgDefaults: Record<string, string> = {
    fill: "rgb(0, 0, 0)",
    stroke: "none",
    "stroke-width": "1px",
    opacity: "1",
    "fill-opacity": "1",
    "stroke-opacity": "1",
  };

  const applyResolvedStyle = (
    clonedEl: Element,
    originalEl: Element,
    computed: CSSStyleDeclaration,
    prop: string,
  ) => {
    const attrValue = originalEl.getAttribute(prop);
    const value = computed.getPropertyValue(prop);

    if (attrValue && attrValue.includes("var(")) {
      clonedEl.removeAttribute(prop);
      if (value && value.trim() && value !== "none") {
        (clonedEl as HTMLElement).style.setProperty(prop, value, "important");
      }
    } else if (value && value.trim()) {
      const isExplicit =
        originalEl.hasAttribute(prop) ||
        (originalEl as HTMLElement).style[prop as any];
      const isDifferent =
        svgDefaults[prop] !== undefined && value !== svgDefaults[prop];
      if (isExplicit || isDifferent) {
        (clonedEl as HTMLElement).style.setProperty(prop, value, "important");
      }
    }
  };

  const allProps = [
    "fill",
    "stroke",
    "color",
    "stop-color",
    "flood-color",
    "lighting-color",
    "stroke-width",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
  ];

  const clonedWithIdx = svgWithResolvedUse.querySelectorAll(`[${FC_IDX}]`);
  clonedWithIdx.forEach(clonedEl => {
    const idxStr = clonedEl.getAttribute(FC_IDX);
    clonedEl.removeAttribute(FC_IDX);
    if (idxStr == null) return;
    const i = parseInt(idxStr, 10);
    if (i < 0 || i >= originalElements.length) return;
    const originalEl = originalElements[i];
    const computed = computedStyles[i]?.computed;
    if (!computed) return;

    for (const prop of allProps) {
      applyResolvedStyle(clonedEl, originalEl, computed, prop);
    }
  });

  return svgWithResolvedUse;
};
