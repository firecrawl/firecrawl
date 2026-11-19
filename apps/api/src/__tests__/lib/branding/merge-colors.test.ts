import { describe, expect, it } from "vitest";

import { mergeBrandingResults } from "../../../lib/branding/merge";
import type { BrandingEnhancement } from "../../../lib/branding/schema";
import type { BrandingProfile } from "../../../types/branding";

const page = (colorScheme: "light" | "dark" = "light"): BrandingProfile =>
  ({
    colorScheme,
    colors: {
      primary: "#0061FE",
      accent: "#E6007A",
      background: colorScheme === "dark" ? "#111111" : "#FFFFFF",
      textPrimary: colorScheme === "dark" ? "#FFFFFF" : "#111111",
      link: "#0044AF",
    },
    __link_measured: true,
  }) as BrandingProfile;

const roles = (
  colorRoles: Partial<BrandingEnhancement["colorRoles"]>,
): BrandingEnhancement => ({
  cleanedFonts: [],
  buttonClassification: {
    primaryButtonIndex: -1,
    primaryButtonReasoning: "",
    secondaryButtonIndex: -1,
    secondaryButtonReasoning: "",
    confidence: 0,
  },
  colorRoles: {
    primaryColor: "",
    accentColor: "",
    backgroundColor: "",
    textPrimary: "",
    confidence: 0.9,
    ...colorRoles,
  },
});

describe("merging the model's color roles", () => {
  it("keeps the measured accent when the model picks a pale tint or a gray", () => {
    for (const accentColor of ["#EDF6FD", "#A2A9B1", "#D9D7FF"]) {
      const merged = mergeBrandingResults(page(), roles({ accentColor }), []);
      expect(merged.colors?.accent).toBe("#E6007A");
    }
    expect(
      mergeBrandingResults(page(), roles({ accentColor: "#FC6D26" }), [])
        .colors?.accent,
    ).toBe("#FC6D26");
  });

  it("falls back to the primary when the measured accent is pale too", () => {
    const js = page();
    js.colors!.accent = "#F2F3F3";
    const merged = mergeBrandingResults(js, roles({ accentColor: "#C9D1D9" }), []);
    expect(merged.colors?.accent).toBe("#0061FE");
  });

  it("ignores a dark page background on a light page, and a light one on a dark page", () => {
    expect(
      mergeBrandingResults(page(), roles({ backgroundColor: "#000000" }), [])
        .colors?.background,
    ).toBe("#FFFFFF");
    expect(
      mergeBrandingResults(page("dark"), roles({ backgroundColor: "#FAFAFA" }), [])
        .colors?.background,
    ).toBe("#111111");
    expect(
      mergeBrandingResults(page(), roles({ backgroundColor: "#FAFAFA" }), [])
        .colors?.background,
    ).toBe("#FAFAFA");
  });

  it("keeps a link that only stood in for the accent following the accent", () => {
    const js = page();
    js.colors!.link = js.colors!.accent;
    (js as any).__link_measured = false;
    const merged = mergeBrandingResults(js, roles({ accentColor: "#FC6D26" }), []);
    expect(merged.colors?.accent).toBe("#FC6D26");
    expect(merged.colors?.link).toBe("#FC6D26");
  });

  it("keeps a measured link color when the model changes the accent, even one equal to the heuristic accent", () => {
    expect(
      mergeBrandingResults(page(), roles({ accentColor: "#FC6D26" }), [])
        .colors?.link,
    ).toBe("#0044AF");
    const js = page();
    js.colors!.link = js.colors!.accent;
    expect(
      mergeBrandingResults(js, roles({ accentColor: "#FC6D26" }), []).colors
        ?.link,
    ).toBe("#E6007A");
  });
});
