import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { generateObject } from "ai";

vi.mock("ai", async importOriginal => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateObject: vi.fn(),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn((name: string) => ({ modelId: name })),
}));

import { config } from "../../../config";
import {
  buildJevRequest,
  cleanFontFamily,
  describeColor,
} from "../../../lib/branding/jev";
import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { BrandingLLMInput } from "../../../lib/branding/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { logger } from "../../../lib/logger";

const LOGO = {
  src: "https://acme.test/logo.svg",
  alt: "Acme",
  isSvg: true,
  isVisible: true,
  location: "header" as const,
  position: { top: 10, left: 10, width: 120, height: 32 },
  indicators: {
    inHeader: true,
    altMatch: true,
    srcMatch: true,
    classMatch: false,
    hrefMatch: true,
  },
  href: "/",
  source: "header a img",
};

const MENU_ICON = {
  ...LOGO,
  src: "https://acme.test/menu.svg",
  alt: "Open menu",
  position: { top: 10, left: 900, width: 20, height: 20 },
  indicators: { ...LOGO.indicators, altMatch: false, hrefMatch: false },
  href: undefined,
};

const baseInput = (costTracking: CostTracking): BrandingLLMInput => ({
  jsAnalysis: {
    colorScheme: "light",
    colors: {
      primary: "#6D28D9",
      background: "#FFFFFF",
      textPrimary: "#111111",
    },
    fonts: [
      { family: "__Inter_d65c78", count: 40 },
      { family: "__Inter_Fallback_d65c78", count: 40 },
      { family: "system-ui", count: 12 },
      { family: "Font Awesome 6 Free", count: 3 },
    ],
  },
  buttons: [
    {
      index: 0,
      text: "Get started",
      html: "",
      classes: "btn bg-violet-700 px-4",
      background: "#6D28D9",
      textColor: "#FFFFFF",
    },
    {
      index: 1,
      text: "Contact sales",
      html: "",
      classes: "btn border px-4",
      background: "transparent",
      textColor: "#111111",
      borderColor: "#111111",
    },
  ],
  logoCandidates: [MENU_ICON, LOGO],
  brandName: "Acme",
  pageTitle: "Acme | Home",
  url: "https://acme.test/",
  teamFlags: { brandingJev: true },
  costTracking,
  logger,
});

// Colors in collection order: #6D28D9, #FFFFFF, #111111.
const jevResponse = (overrides: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  answers: {
    logo: {
      type: "choice",
      choice: "logo_1",
      probabilities: { logo_0: 0.04, logo_1: 0.95, none: 0.01 },
      confidence: 0.9,
    },
    primary_button: {
      type: "choice",
      choice: "button_0",
      probabilities: { button_0: 0.9, button_1: 0.1 },
      confidence: 0.85,
    },
    secondary_button: {
      type: "choice",
      choice: "button_1",
      probabilities: { button_0: 0.1, button_1: 0.85, none: 0.05 },
      confidence: 0.8,
    },
    primary_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.9, color_1: 0.05, color_2: 0.05 },
      confidence: 0.88,
    },
    accent_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.8, color_1: 0.1, color_2: 0.1 },
      confidence: 0.7,
    },
    secondary_color: {
      type: "choice",
      choice: "none",
      probabilities: { color_0: 0.1, color_1: 0.1, color_2: 0.1, none: 0.7 },
      confidence: 0.6,
    },
    background_color: {
      type: "choice",
      choice: "color_1",
      probabilities: { color_0: 0.02, color_1: 0.96, color_2: 0.02 },
      confidence: 0.94,
    },
    text_color: {
      type: "choice",
      choice: "color_2",
      probabilities: { color_0: 0.02, color_1: 0.03, color_2: 0.95 },
      confidence: 0.92,
    },
    font_0_is_brand: { type: "noul", noul: 0.97 },
    font_0_role: {
      type: "choice",
      choice: "body",
      probabilities: { body: 0.8, heading: 0.2 },
      confidence: 0.7,
    },
    font_1_is_brand: { type: "noul", noul: 0.08 },
    font_1_role: {
      type: "choice",
      choice: "unknown",
      probabilities: { unknown: 1 },
      confidence: 0.9,
    },
    tone: {
      type: "choice",
      choice: "modern",
      probabilities: { modern: 0.7 },
      confidence: 0.6,
    },
    energy: {
      type: "choice",
      choice: "medium",
      probabilities: { medium: 0.8 },
      confidence: 0.7,
    },
    audience: {
      type: "choice",
      choice: "businesses",
      probabilities: { businesses: 0.6 },
      confidence: 0.5,
    },
    framework: {
      type: "choice",
      choice: "tailwind",
      probabilities: { tailwind: 0.9 },
      confidence: 0.8,
    },
    component_library: {
      type: "choice",
      choice: "none",
      probabilities: { none: 0.9 },
      confidence: 0.8,
    },
    ...overrides,
  },
  usage: { input_tokens: 2000, output_tokens: 60 },
});

let fetchMock: Mock;
const saved = {
  key: config.TYPESAFE_API_KEY,
  global: config.BRANDING_JEV,
  escalate: config.BRANDING_JEV_ESCALATE_BELOW,
};

beforeEach(() => {
  config.TYPESAFE_API_KEY = "ts-test";
  config.BRANDING_JEV = undefined;
  config.BRANDING_JEV_ESCALATE_BELOW = undefined;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  (generateObject as Mock).mockReset().mockResolvedValue({
    object: {
      cleanedFonts: [],
      buttonClassification: {
        primaryButtonIndex: -1,
        primaryButtonReasoning: "none",
        secondaryButtonIndex: -1,
        secondaryButtonReasoning: "none",
        confidence: 0.5,
      },
      colorRoles: {
        primaryColor: "#000000",
        accentColor: "#000000",
        backgroundColor: "#FFFFFF",
        textPrimary: "#000000",
        confidence: 0.5,
      },
    },
    usage: { inputTokens: 6000, outputTokens: 400 },
  });
});

afterEach(() => {
  config.TYPESAFE_API_KEY = saved.key;
  config.BRANDING_JEV = saved.global;
  config.BRANDING_JEV_ESCALATE_BELOW = saved.escalate;
  vi.unstubAllGlobals();
});

const respondWith = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

describe("branding with Jev", () => {
  it("answers branding from Jev and records its cost instead of an LLM call", async () => {
    respondWith(jevResponse());
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).not.toHaveBeenCalled();
    expect(result.logoSelection?.selectedLogoIndex).toBe(1);
    expect(result.logoSelection?.confidence).toBe(0.9);
    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
    expect(result.colorRoles).toMatchObject({
      primaryColor: "#6D28D9",
      accentColor: "#6D28D9",
      secondaryColor: "",
      backgroundColor: "#FFFFFF",
      textPrimary: "#111111",
    });
    expect(result.colorRoles.confidence).toBeCloseTo((0.88 + 0.94 + 0.92) / 3);
    expect(result.cleanedFonts).toEqual([{ family: "Inter", role: "body" }]);
    expect(result.personality).toEqual({
      tone: "modern",
      energy: "medium",
      targetAudience: "businesses",
    });
    expect(result.designSystem).toEqual({
      framework: "tailwind",
      componentLibrary: "",
    });

    expect(costTracking.calls).toHaveLength(1);
    expect(costTracking.calls[0]).toMatchObject({
      model: "jev-1.13.0",
      metadata: { module: "branding", method: "enhanceBrandingWithJev" },
      tokens: { input: 2000, output: 60 },
    });
    expect(costTracking.calls[0].cost).toBeCloseTo(
      (2000 * 0.042) / 1_000_000,
      12,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer ts-test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions.logo.criteria)).toEqual([
      "logo_0",
      "logo_1",
      "none",
    ]);
  });

  it("never returns the background as the text color or one button as both", async () => {
    respondWith(
      jevResponse({
        text_color: {
          type: "choice",
          choice: "color_1",
          probabilities: { color_0: 0.05, color_1: 0.6, color_2: 0.35 },
          confidence: 0.4,
        },
        secondary_button: {
          type: "choice",
          choice: "button_0",
          probabilities: { button_0: 0.7, button_1: 0.2, none: 0.1 },
          confidence: 0.5,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(result.colorRoles.backgroundColor).toBe("#FFFFFF");
    expect(result.colorRoles.textPrimary).toBe("#111111");
    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
  });

  it("keeps the heuristic value for a color role Jev is unsure of", async () => {
    respondWith(
      jevResponse({
        accent_color: {
          type: "choice",
          choice: "color_2",
          probabilities: { color_0: 0.3, color_1: 0.3, color_2: 0.4 },
          confidence: 0.1,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(result.colorRoles.accentColor).toBe("");
    expect(result.colorRoles.primaryColor).toBe("#6D28D9");
  });

  it("takes font roles from the page's typography when it has them", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "__Inter_d65c78", heading: "Söhne" },
    };
    input.jsAnalysis.fonts = [
      { family: "__Inter_d65c78", count: 40 },
      { family: "Söhne", count: 10 },
    ];

    const request = buildJevRequest(input);
    expect(request.questions.font_0_role).toBeUndefined();
    expect(request.questions.font_1_role).toBeUndefined();

    respondWith(jevResponse({ font_1_is_brand: { type: "noul", noul: 0.9 } }));
    const result = await enhanceBrandingWithLLM(input);
    expect(result.cleanedFonts).toEqual([
      { family: "Inter", role: "body" },
      { family: "Söhne", role: "heading" },
    ]);
  });

  it("treats a pick between identical-looking buttons as confident", async () => {
    const input = baseInput(new CostTracking());
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
    });
    respondWith(
      jevResponse({
        primary_button: {
          type: "choice",
          choice: "button_0",
          // split between the two violet buttons
          probabilities: { button_0: 0.48, button_1: 0.04, button_2: 0.48 },
          confidence: 0.35,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.primaryButtonIndex).toBe(0);
    expect(result.buttonClassification.confidence).toBeCloseTo(0.96);
  });

  it("falls back to the LLM when the TypeSafe API errors", async () => {
    respondWith({ detail: "invalid api key" }, 401);
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.colorRoles.primaryColor).toBe("#000000");
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithLLM",
    ]);
  });

  it("retries once when TypeSafe is rate limited", async () => {
    respondWith({ detail: "slow down" }, 429);
    respondWith(jevResponse());

    const result = await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(generateObject).not.toHaveBeenCalled();
    expect(result.logoSelection?.selectedLogoIndex).toBe(1);
  });

  it("escalates to the LLM when Jev is unsure of the logo", async () => {
    config.BRANDING_JEV_ESCALATE_BELOW = 0.6;
    respondWith(
      jevResponse({
        logo: {
          type: "choice",
          choice: "logo_1",
          probabilities: { logo_0: 0.45, logo_1: 0.5, none: 0.05 },
          confidence: 0.3,
        },
      }),
    );
    const costTracking = new CostTracking();

    await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithJev",
      "enhanceBrandingWithLLM",
    ]);
  });

  it("keeps zero-data-retention scrapes and unflagged teams off Jev", async () => {
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      zeroDataRetention: true,
    });
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      teamFlags: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});

describe("Jev request building", () => {
  it("describes colors by name and never sends hex values", () => {
    const request = buildJevRequest(baseInput(new CostTracking()));
    const state = JSON.stringify(request.state);

    expect(state).not.toMatch(/#[0-9a-f]{6}/i);
    expect(request.state.colors).toMatchObject({
      color_0: { looks: "vivid violet" },
      color_1: { looks: "white" },
      color_2: { looks: "near-black" },
    });
    expect(request.colors.map(c => c.hex)).toEqual([
      "#6D28D9",
      "#FFFFFF",
      "#111111",
    ]);
  });

  it("names common colors", () => {
    expect(describeColor("#E2511A")).toBe("vivid orange");
    expect(describeColor("#0A2540")).toBe("very dark blue");
    expect(describeColor("#F6F9FC")).toBe("near-white");
    expect(describeColor("#1A73E8")).toBe("vivid blue");
  });

  it("cleans font names in code", () => {
    expect(cleanFontFamily("__Roboto_Mono_c8ca7d")).toBe("Roboto Mono");
    expect(cleanFontFamily("__suisse_6d5c28")).toBe("Suisse");
    expect(cleanFontFamily("__suisse_Fallback_6d5c28")).toBeUndefined();
    expect(cleanFontFamily("var(--font-sans)")).toBeUndefined();
    expect(cleanFontFamily("'Söhne'")).toBe("Söhne");
    expect(cleanFontFamily("ui-sans-serif")).toBeUndefined();
  });
});
