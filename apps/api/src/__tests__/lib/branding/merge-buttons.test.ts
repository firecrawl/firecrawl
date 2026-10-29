import { describe, it, expect } from "vitest";

import { mergeBrandingResults } from "../../../lib/branding/merge";
import type { BrandingEnhancement } from "../../../lib/branding/schema";
import type { ButtonSnapshot } from "../../../lib/branding/types";

const button = (
  index: number,
  text: string,
  background: string,
  textColor: string,
): ButtonSnapshot => ({
  index,
  text,
  html: `<a>${text}</a>`,
  classes: "btn",
  background,
  textColor,
  borderRadius: "30px",
});

const BUTTONS = [
  button(0, "Home", "transparent", "#333333"),
  button(1, "Book an Appointment", "#0099FF", "#FFFFFF"),
  button(2, "Contact us", "#0B2545", "#FFFFFF"),
];

const answer = (
  confidence: number,
  primaryButtonIndex = 1,
  secondaryButtonIndex = 2,
): BrandingEnhancement => ({
  cleanedFonts: [],
  buttonClassification: {
    primaryButtonIndex,
    primaryButtonReasoning: "jev: p=0.39",
    secondaryButtonIndex,
    secondaryButtonReasoning: "jev: p=0.31",
    confidence,
  },
  colorRoles: {
    primaryColor: "",
    accentColor: "",
    backgroundColor: "",
    textPrimary: "",
    confidence: 0,
  },
});

describe("merging the model's button picks", () => {
  it("keeps a pick the model was unsure of rather than leaving the page without buttons", () => {
    const merged = mergeBrandingResults({}, answer(0.39), BUTTONS);

    expect(merged.components?.buttonPrimary).toMatchObject({
      background: "#0099FF",
      textColor: "#FFFFFF",
      borderRadius: "30px",
    });
    expect(merged.components?.buttonSecondary).toMatchObject({
      background: "#0B2545",
    });
  });

  it("adds no buttons when the model call failed", () => {
    // Valid indices, so only the confidence check keeps them out.
    const merged = mergeBrandingResults({}, answer(0), BUTTONS);

    expect(merged.components?.buttonPrimary).toBeUndefined();
    expect(merged.components?.buttonSecondary).toBeUndefined();
  });
});
