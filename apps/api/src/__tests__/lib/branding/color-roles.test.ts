import { describe, it, expect } from "vitest";
import { mergeBrandingResults } from "../../../lib/branding/merge";
import { processRawBranding } from "../../../lib/branding/processor";
import {
  isNearBlack,
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
});
