import { toPx } from "./helpers";

export interface CSSData {
  colors: string[];
  spacings: number[];
  radii: number[];
}

export const collectCSSData = (): CSSData => {
  const data: CSSData = {
    colors: [],
    spacings: [],
    radii: [],
  };

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null;
    try {
      rules = sheet.cssRules;
    } catch {
      // CORS stylesheets throw SecurityError when accessing cssRules - this is expected
      continue;
    }
    if (!rules) continue;

    for (const rule of Array.from(rules)) {
      try {
        if (rule.type === CSSRule.STYLE_RULE) {
          const s = (rule as CSSStyleRule).style;

          [
            "color",
            "background-color",
            "border-color",
            "fill",
            "stroke",
          ].forEach(prop => {
            const val = s.getPropertyValue(prop);
            if (val) data.colors.push(val);
          });

          [
            "border-radius",
            "border-top-left-radius",
            "border-top-right-radius",
            "border-bottom-left-radius",
            "border-bottom-right-radius",
          ].forEach(p => {
            const v = toPx(s.getPropertyValue(p));
            if (v) data.radii.push(v);
          });

          [
            "margin",
            "margin-top",
            "margin-right",
            "margin-bottom",
            "margin-left",
            "padding",
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
            "gap",
            "row-gap",
            "column-gap",
          ].forEach(p => {
            const v = toPx(s.getPropertyValue(p));
            if (v) data.spacings.push(v);
          });
        }
      } catch {
        // Ignore individual rule errors
      }
    }
  }

  return data;
};
