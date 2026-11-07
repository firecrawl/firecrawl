import { describe, it, expect } from "vitest";
import { isPageControl } from "../../../lib/branding/page-controls";
import { pickDistinctStylesFirst } from "../../../lib/branding/transformer";

const button = (text: string, background: string, borderColor?: string) => ({
  btn: {
    index: 0,
    text,
    html: "",
    classes: "",
    background,
    textColor: background === "transparent" ? "#111111" : "#FFFFFF",
    borderColor,
  },
});

describe("choosing which buttons the model sees", () => {
  it("keeps a second style that ranks below many look-alike buttons", () => {
    const ranked = [
      ...Array.from({ length: 14 }, (_, i) => button(`Order ${i}`, "#C82540")),
      button("Contact sales", "transparent", "#111111"),
    ];

    const picked = pickDistinctStylesFirst(ranked, 12);

    expect(picked).toHaveLength(12);
    expect(picked.map(p => p.btn.text)).toContain("Contact sales");
    expect(picked[0].btn.text).toBe("Order 0");
  });

  it("keeps ranking order and fills up with the best of the rest", () => {
    const ranked = [
      button("Buy", "#C82540"),
      button("Buy again", "#C82540"),
      button("Learn more", "transparent", "#111111"),
    ];

    expect(pickDistinctStylesFirst(ranked, 2).map(p => p.btn.text)).toEqual([
      "Buy",
      "Learn more",
    ]);
    expect(pickDistinctStylesFirst(ranked, 3).map(p => p.btn.text)).toEqual([
      "Buy",
      "Buy again",
      "Learn more",
    ]);
  });
});

describe("page controls", () => {
  it("recognises skip links and map controls, but not real calls to action", () => {
    const controls = [
      "Skip to content",
      "Skip to main content",
      "Satellite",
      "Map",
      "View fullsize",
      "Toggle fullscreen",
      "Zoom in",
      "Zoom out",
    ];
    const actions = [
      "Search",
      "Next",
      "Shop the map collection",
      "Contact sales",
      "View our work",
    ];
    expect(controls.filter(text => isPageControl({ text }))).toEqual(controls);
    expect(actions.filter(text => isPageControl({ text }))).toEqual([]);
  });
});
