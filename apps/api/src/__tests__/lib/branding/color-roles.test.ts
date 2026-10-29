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

describe("monochrome brands", () => {
  const button = (background: string, textColor: string, index: number) => ({
    index,
    text: `Button ${index}`,
    html: "",
    classes: "",
    background,
    textColor,
  });
  const llmPicking = (primaryColor: string) => ({
    ...emptyLlm,
    buttonClassification: {
      primaryButtonIndex: 0,
      primaryButtonReasoning: "n/a",
      secondaryButtonIndex: -1,
      secondaryButtonReasoning: "n/a",
      confidence: 0.9,
    },
    colorRoles: {
      primaryColor,
      accentColor: "",
      backgroundColor: "#FFFFFF",
      textPrimary: "#171717",
      confidence: 0.8,
    },
  });

  it("uses the black call to action when the chosen color is only a link color", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      llmPicking("#0072F5"),
      [button("#171717", "#FFFFFF", 0), button("#FFFFFF", "#171717", 1)],
    );
    expect(merged.colors?.primary).toBe("#171717");
    expect(merged.colors?.accent).toBe("#0072F5");
  });

  it("keeps a color that also fills a button", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      llmPicking("#0071E3"),
      [button("#000000", "#FFFFFF", 0), button("#0071E3", "#FFFFFF", 1)],
    );
    expect(merged.colors?.primary).toBe("#0071E3");
  });

  it("keeps a navy call to action from replacing the brand color", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      llmPicking("#635BFF"),
      [button("#0A2540", "#FFFFFF", 0)],
    );
    expect(merged.colors?.primary).toBe("#635BFF");
  });

  it("drops saturated colors no button uses, but keeps the displaced link color", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      {
        ...llmPicking("#0072F5"),
        colorRoles: {
          ...llmPicking("#0072F5").colorRoles,
          secondaryColor: "#FFC96B",
          accentColor: "#9A050F",
        },
      },
      [button("#171717", "#FFFFFF", 0), button("#FFFFFF", "#171717", 1)],
    );
    expect(merged.colors?.primary).toBe("#171717");
    expect(merged.colors?.accent).toBe("#171717");
    expect(merged.colors?.secondary).toBeUndefined();

    const linkOnly = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      llmPicking("#0072F5"),
      [button("#171717", "#FFFFFF", 0)],
    );
    expect(linkOnly.colors?.accent).toBe("#0072F5");
  });

  it("keeps saturated accents when the primary is navy chrome or there is no black call to action", () => {
    const navy = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      {
        ...llmPicking("#061B31"),
        colorRoles: {
          ...llmPicking("#061B31").colorRoles,
          accentColor: "#635BFF",
        },
      },
      [button("#061B31", "#FFFFFF", 0)],
    );
    expect(navy.colors?.accent).toBe("#635BFF");

    const noButtons = mergeBrandingResults(
      { colorScheme: "light", colors: {} },
      {
        ...llmPicking("#111111"),
        colorRoles: {
          ...llmPicking("#111111").colorRoles,
          accentColor: "#E51503",
        },
      },
      [],
    );
    expect(noButtons.colors?.accent).toBe("#E51503");
  });

  it("leaves dark pages alone", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "dark", colors: {} },
      llmPicking("#1ED760"),
      [button("#111111", "#FFFFFF", 0)],
    );
    expect(merged.colors?.primary).toBe("#1ED760");
  });
});

describe("browser link colors from the model", () => {
  it("keeps the heuristic colors when the model answers with the default link blue", () => {
    const merged = mergeBrandingResults(
      {
        colorScheme: "light",
        colors: {
          primary: "#C82540",
          accent: "#F9B200",
          secondary: "#2E7D32",
        },
      },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#0000ee",
          secondaryColor: "#0000EE",
          accentColor: "#551A8B",
          backgroundColor: "#FFFFFF",
          textPrimary: "#212121",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.primary).toBe("#C82540");
    expect(merged.colors?.accent).toBe("#F9B200");
    expect(merged.colors?.secondary).toBe("#2E7D32");
  });
});

describe("near-white primaries", () => {
  it("keeps the brand color when the model answers with a pale section background", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { primary: "#533AFD" } },
      {
        ...emptyLlm,
        colorRoles: {
          primaryColor: "#E5EDF5",
          accentColor: "#533AFD",
          backgroundColor: "#FFFFFF",
          textPrimary: "#0A2540",
          confidence: 0.9,
        },
      },
      [],
    );
    expect(merged.colors?.primary).toBe("#533AFD");
  });

  it("skips a pale tint when picking the primary on a light page", () => {
    expect(
      pickBrandPrimary(["#F0F6FF", "#0056D2", "#FFFFFF"], {
        background: "#FFFFFF",
        colorScheme: "light",
      }),
    ).toBe("#0056D2");
  });

  it("keeps a light brand color on a dark page", () => {
    expect(
      pickBrandPrimary(["#E7DBFF", "#0A0A0A"], {
        background: "#0A0A0A",
        colorScheme: "dark",
      }),
    ).toBe("#E7DBFF");
  });
});

describe("logo color and measured text color", () => {
  const logo = "https://acme.test/logo.svg";
  const candidate = (colors: Array<{ color: string; share: number }>) =>
    ({
      src: logo,
      alt: "Acme",
      isSvg: true,
      isVisible: true,
      location: "header",
      position: { top: 10, left: 10, width: 120, height: 32 },
      indicators: {
        inHeader: true,
        altMatch: true,
        srcMatch: true,
        classMatch: false,
        hrefMatch: true,
      },
      source: "img",
      colors,
    }) as any;
  const llm = (primaryColor: string, textPrimary = "#111111") => ({
    cleanedFonts: [],
    buttonClassification: {
      primaryButtonIndex: -1,
      primaryButtonReasoning: "n/a",
      secondaryButtonIndex: -1,
      secondaryButtonReasoning: "n/a",
      confidence: 0,
    },
    colorRoles: {
      primaryColor,
      accentColor: "",
      backgroundColor: "#FFFFFF",
      textPrimary,
      confidence: 0.8,
    },
  });

  it("takes the logo's color as primary when the extracted one is pale or far from it", () => {
    const pale = mergeBrandingResults(
      {
        colorScheme: "light",
        colors: { primary: "#FFE6AA" },
        images: { logo },
      },
      llm("#FFE6AA"),
      [],
      [
        candidate([
          { color: "#0071DC", share: 0.6 },
          { color: "#FFC220", share: 0.3 },
        ]),
      ],
    );
    expect(pale.colors?.primary).toBe("#0071DC");

    const far = mergeBrandingResults(
      { colorScheme: "light", colors: {}, images: { logo } },
      llm("#F6339A"),
      [],
      [candidate([{ color: "#00A6F4", share: 0.8 }])],
    );
    expect(far.colors?.primary).toBe("#00A6F4");
  });

  it("keeps a primary that is the logo's color, and ignores a black logo", () => {
    const close = mergeBrandingResults(
      { colorScheme: "light", colors: {}, images: { logo } },
      llm("#0074E0"),
      [],
      [candidate([{ color: "#0071DC", share: 0.9 }])],
    );
    expect(close.colors?.primary).toBe("#0074E0");

    const black = mergeBrandingResults(
      { colorScheme: "light", colors: {}, images: { logo } },
      llm("#E51503"),
      [],
      [candidate([{ color: "#000000", share: 1 }])],
    );
    expect(black.colors?.primary).toBe("#E51503");
  });

  it("keeps the measured neutral text color over a saturated pick", () => {
    const merged = mergeBrandingResults(
      { colorScheme: "light", colors: { textPrimary: "#202122" } },
      llm("#3366CC", "#3366CC"),
      [],
    );
    expect(merged.colors?.textPrimary).toBe("#202122");
  });
});
