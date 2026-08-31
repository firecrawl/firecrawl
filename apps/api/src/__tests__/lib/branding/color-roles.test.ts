import { describe, it, expect } from "vitest";
import { mergeBrandingResults } from "../../../lib/branding/merge";
import { processRawBranding } from "../../../lib/branding/processor";
import {
  isNearBlack,
  isUsableBrandPrimary,
  isUsableCtaBackground,
  normalizeRoleHex,
  pickBrandPrimary,
  shouldApplyLlmColorRoles,
} from "../../../lib/branding/color-roles";
import type { BrandingScriptReturn } from "../../../lib/branding/types";

const emptyLlm = {
  cleanedFonts: [] as [],
  buttonClassification: {
    primaryButtonIndex: -1,
    primaryButtonReasoning: "n/a",
    secondaryButtonIndex: -1,
    secondaryButtonReasoning: "n/a",
    confidence: 0,
  },
};

describe("pickBrandPrimary", () => {
  it("skips navy header chrome on a light page", () => {
    expect(
      pickBrandPrimary(["#061B31", "#635BFF", "#FFFFFF"], {
        background: "#FFFFFF",
        textPrimary: "#0A2540",
        colorScheme: "light",
      }),
    ).toBe("#635BFF");
  });

  it("keeps a dark chromatic color on a dark page", () => {
    expect(
      pickBrandPrimary(["#0A0A0A", "#22C55E"], {
        background: "#0A0A0A",
        colorScheme: "dark",
      }),
    ).toBe("#22C55E");
  });

  it("uses a black CTA as primary instead of a chromatic wash", () => {
    expect(
      pickBrandPrimary(["#CB9FD2", "#000000", "#FFFFFF"], {
        background: "#FFFFFF",
        colorScheme: "light",
        cta: "#000000",
      }),
    ).toBe("#000000");
  });

  it("still prefers a chromatic CTA over navy header chrome", () => {
    expect(
      pickBrandPrimary(["#061B31", "#635BFF", "#FFFFFF"], {
        background: "#FFFFFF",
        colorScheme: "light",
        cta: "#635BFF",
      }),
    ).toBe("#635BFF");
  });

  it("does not treat saturated blue as near-black chrome", () => {
    expect(isNearBlack("#0000FF")).toBe(false);
    expect(isNearBlack("#061B31")).toBe(true);
    expect(isNearBlack("#000080")).toBe(true);
    expect(
      pickBrandPrimary(["#061B31", "#0000FF"], {
        background: "#FFFFFF",
        colorScheme: "light",
      }),
    ).toBe("#0000FF");
    expect(
      pickBrandPrimary(["#000080", "#635BFF"], {
        background: "#FFFFFF",
        colorScheme: "light",
      }),
    ).toBe("#635BFF");
  });

  it("keeps saturated bright fills as usable CTAs but rejects pale washes", () => {
    expect(isUsableCtaBackground("#FFFF00")).toBe(true);
    expect(isUsableCtaBackground("#FFFFFF")).toBe(false);
    expect(isUsableCtaBackground("#F5F0E8")).toBe(false);
  });

  it("rejects a non-CTA near-black gray on dark pages", () => {
    expect(isUsableBrandPrimary("#1A1A1A", "dark")).toBe(false);
    expect(isUsableBrandPrimary("#1A1A1A", "dark", { cta: "#1A1A1A" })).toBe(
      true,
    );
  });
});

describe("normalizeRoleHex / LLM gate", () => {
  it("rejects color names", () => {
    expect(normalizeRoleHex("navy")).toBeUndefined();
    expect(normalizeRoleHex("#635BFF")).toBe("#635BFF");
    expect(normalizeRoleHex("#63f")).toBe("#6633FF");
  });

  it("applies LLM colors at 0.5+ and rescues chrome at 0.4+", () => {
    expect(shouldApplyLlmColorRoles(0.6, "#635BFF", "#061B31", "light")).toBe(
      true,
    );
    expect(shouldApplyLlmColorRoles(0.5, "#635BFF", "#FF4C00", "light")).toBe(
      true,
    );
    expect(shouldApplyLlmColorRoles(0.45, "#635BFF", "#061B31", "light")).toBe(
      true,
    );
    expect(shouldApplyLlmColorRoles(0.45, "#635BFF", "#635BFF", "light")).toBe(
      false,
    );
    expect(shouldApplyLlmColorRoles(0.2, "#635BFF", "#061B31", "light")).toBe(
      false,
    );
  });
});

describe("merge color roles", () => {
  it("applies a valid LLM primary at confidence 0.6", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { primary: "#061B31" } },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#635BFF",
          accentColor: "#635BFF",
          backgroundColor: "#FFFFFF",
          textPrimary: "#0A2540",
          confidence: 0.6,
        },
      },
      [],
    );
    expect(merged.colors?.primary).toBe("#635BFF");
  });

  it("does not let a color name overwrite the heuristic", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { primary: "#FF4C00" } },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "orange",
          accentColor: "",
          backgroundColor: "",
          textPrimary: "",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.primary).toBe("#FF4C00");
  });

  it("promotes a black primary button over an LLM wash", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { primary: "#CB9FD2" } },
      {
        ...emptyLlm,
        buttonClassification: {
          primaryButtonIndex: 0,
          primaryButtonReasoning: "black get started",
          secondaryButtonIndex: -1,
          secondaryButtonReasoning: "n/a",
          confidence: 0.9,
        },
        colorRoles: {
          primaryColor: "#CB9FD2",
          accentColor: "#1A73E8",
          backgroundColor: "#FFFFFF",
          textPrimary: "#000000",
          confidence: 0.9,
        },
      },
      [
        {
          index: 0,
          text: "Get started",
          html: "",
          classes: "",
          background: "#000000",
          textColor: "#FFFFFF",
        },
      ],
    );
    expect(merged.colors?.primary).toBe("#000000");
    expect(merged.components?.buttonPrimary?.background).toBe("#000000");
  });

  it("does not promote a ghost button matching the page background", () => {
    const merged = mergeBrandingResults(
      {
        colorScheme: "dark",
        colors: { primary: "#22C55E", background: "#0A0A0A" },
      },
      {
        ...emptyLlm,
        buttonClassification: {
          primaryButtonIndex: 0,
          primaryButtonReasoning: "outline button",
          secondaryButtonIndex: -1,
          secondaryButtonReasoning: "n/a",
          confidence: 0.9,
        },
        colorRoles: {
          primaryColor: "#22C55E",
          accentColor: "#22C55E",
          backgroundColor: "#0A0A0A",
          textPrimary: "#FFFFFF",
          confidence: 0.9,
        },
      },
      [
        {
          index: 0,
          text: "Learn more",
          html: "",
          classes: "",
          background: "#0A0A0A",
          textColor: "#FFFFFF",
        },
      ],
    );
    expect(merged.colors?.primary).toBe("#22C55E");
  });

  it("does not let a high-confidence navy LLM primary overwrite a brand color", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { primary: "#635BFF" } },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#061B31",
          accentColor: "#635BFF",
          backgroundColor: "#FFFFFF",
          textPrimary: "#0A2540",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.primary).toBe("#635BFF");
    expect(merged.colors?.background).toBe("#FFFFFF");
  });

  it("keeps heuristic secondary when the LLM returns a non-hex secondary", () => {
    const merged = mergeBrandingResults(
      {
        colorScheme: "light",
        colors: { primary: "#635BFF", secondary: "#00D4FF" },
      },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#635BFF",
          secondaryColor: "navy",
          accentColor: "#635BFF",
          backgroundColor: "#FFFFFF",
          textPrimary: "#0A2540",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.secondary).toBe("#00D4FF");
  });

  it("drops heuristic secondary when the LLM omits secondaryColor", () => {
    const merged = mergeBrandingResults(
      {
        colorScheme: "light",
        colors: { primary: "#635BFF", secondary: "#00D4FF" },
      },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#635BFF",
          accentColor: "#635BFF",
          backgroundColor: "#FFFFFF",
          textPrimary: "#0A2540",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.secondary).toBeUndefined();
  });
});

type Snapshot = BrandingScriptReturn["snapshots"][number];

function snap(
  partial: Omit<Partial<Snapshot>, "colors"> & {
    colors?: Partial<Snapshot["colors"]>;
  },
): Snapshot {
  const { colors, ...rest } = partial;
  return {
    tag: "div",
    classes: "",
    text: "",
    rect: { w: 100, h: 40 },
    typography: { fontStack: ["Inter"], size: "16px", weight: 400 },
    radius: 0,
    borderRadius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    shadow: null,
    isButton: false,
    isInput: false,
    isLink: false,
    ...rest,
    colors: {
      text: "rgb(0, 0, 0)",
      background: "rgb(255, 255, 255)",
      border: "transparent",
      borderWidth: 0,
      ...colors,
    },
  };
}

describe("processRawBranding primary", () => {
  it("prefers a CTA button color over a large navy header", () => {
    const profile = processRawBranding({
      cssData: { colors: [], spacings: [], radii: [] },
      snapshots: [
        snap({
          tag: "header",
          rect: { w: 1400, h: 80 },
          colors: { background: "rgb(6, 27, 49)", text: "rgb(255, 255, 255)" },
        }),
        snap({
          tag: "button",
          text: "Get started",
          isButton: true,
          hasCTAIndicator: true,
          rect: { w: 140, h: 44 },
          colors: {
            background: "rgb(99, 91, 255)",
            text: "rgb(255, 255, 255)",
          },
        }),
      ],
      images: [],
      typography: {
        stacks: { body: ["Inter"], heading: ["Inter"], paragraph: ["Inter"] },
        sizes: { h1: "32px", h2: "24px", body: "16px" },
      },
      frameworkHints: [],
      colorScheme: "light",
      pageBackground: "rgb(255, 255, 255)",
    });

    expect(profile.colors?.primary).toBe("#635BFF");
  });

  it("uses a black CTA as primary instead of a large lilac wash", () => {
    const profile = processRawBranding({
      cssData: { colors: [], spacings: [], radii: [] },
      snapshots: [
        snap({
          tag: "section",
          rect: { w: 1400, h: 600 },
          colors: { background: "rgb(203, 159, 210)", text: "rgb(0, 0, 0)" },
        }),
        snap({
          tag: "button",
          text: "Get started",
          isButton: true,
          hasCTAIndicator: true,
          rect: { w: 140, h: 44 },
          colors: {
            background: "rgb(0, 0, 0)",
            text: "rgb(255, 255, 255)",
          },
        }),
      ],
      images: [],
      typography: {
        stacks: { body: ["Inter"], heading: ["Inter"], paragraph: ["Inter"] },
        sizes: { h1: "32px", h2: "24px", body: "16px" },
      },
      frameworkHints: [],
      colorScheme: "light",
      pageBackground: "rgb(255, 255, 255)",
    });

    expect(profile.colors?.primary).toBe("#000000");
  });

  it("ranks CTA fills instead of taking the first DOM-order button", () => {
    const profile = processRawBranding({
      cssData: { colors: [], spacings: [], radii: [] },
      snapshots: [
        snap({
          tag: "a",
          text: "Learn more",
          isButton: true,
          hasCTAIndicator: true,
          rect: { w: 120, h: 40 },
          colors: {
            background: "rgb(51, 68, 51)",
            text: "rgb(255, 255, 255)",
          },
        }),
        snap({
          tag: "button",
          text: "Get started",
          isButton: true,
          hasCTAIndicator: true,
          rect: { w: 140, h: 44 },
          colors: {
            background: "rgb(99, 91, 255)",
            text: "rgb(255, 255, 255)",
          },
        }),
        snap({
          tag: "a",
          text: "Sign up free",
          isButton: true,
          hasCTAIndicator: true,
          rect: { w: 140, h: 44 },
          colors: {
            background: "rgb(99, 91, 255)",
            text: "rgb(255, 255, 255)",
          },
        }),
      ],
      images: [],
      typography: {
        stacks: { body: ["Inter"], heading: ["Inter"], paragraph: ["Inter"] },
        sizes: { h1: "32px", h2: "24px", body: "16px" },
      },
      frameworkHints: [],
      colorScheme: "light",
      pageBackground: "rgb(255, 255, 255)",
    });

    expect(profile.colors?.primary).toBe("#635BFF");
  });
});
