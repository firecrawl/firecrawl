import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { generateObject } from "ai";

const mocks = vi.hoisted(() => ({ systemOne: vi.fn() }));

vi.mock("@typesafe-ai/sdk", async importOriginal => ({
  ...(await importOriginal<typeof import("@typesafe-ai/sdk")>()),
  TypeSafeClient: class {
    systemOne = mocks.systemOne;
  },
}));
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
  resetJevBreaker,
} from "../../../lib/branding/jev";
import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { mergeBrandingResults } from "../../../lib/branding/merge";
import { BrandingLLMInput } from "../../../lib/branding/types";
import { CostTracking } from "../../../lib/cost-tracking";
import { logger } from "../../../lib/logger";
import * as tracer from "../../../lib/otel-tracer";

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
  teamId: "team-jev",
  mode: "fast",
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

const saved = {
  key: config.TYPESAFE_API_KEY,
  global: config.BRANDING_JEV,
  teamIds: config.BRANDING_JEV_TEAM_IDS,
  rollout: config.BRANDING_JEV_ROLLOUT_PERCENT,
  escalate: config.BRANDING_JEV_ESCALATE_BELOW,
};

beforeEach(() => {
  resetJevBreaker();
  config.TYPESAFE_API_KEY = "ts-test";
  config.BRANDING_JEV = undefined;
  config.BRANDING_JEV_TEAM_IDS = ["team-jev"];
  config.BRANDING_JEV_ROLLOUT_PERCENT = 0;
  config.BRANDING_JEV_ESCALATE_BELOW = undefined;
  mocks.systemOne.mockReset();
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
  vi.useRealTimers();
  config.TYPESAFE_API_KEY = saved.key;
  config.BRANDING_JEV = saved.global;
  config.BRANDING_JEV_TEAM_IDS = saved.teamIds;
  config.BRANDING_JEV_ROLLOUT_PERCENT = saved.rollout;
  config.BRANDING_JEV_ESCALATE_BELOW = saved.escalate;
});

const respondWith = (body: unknown) =>
  mocks.systemOne.mockResolvedValueOnce(body);

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

    const [request, options] = mocks.systemOne.mock.calls[0];
    expect(request.model).toBe("jev-latest");
    expect(options).toEqual({ timeout: 5000, retry: { maxRetries: 1 } });
    expect(Object.keys(request.questions.logo.criteria)).toEqual([
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
    const input = baseInput(new CostTracking());
    input.jsAnalysis.colors = { ...input.jsAnalysis.colors, accent: "#FF5500" };
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

    const result = await enhanceBrandingWithLLM(input);

    expect(result.colorRoles.accentColor).toBe("");
    expect(result.colorRoles.primaryColor).toBe("#6D28D9");
    const merged = mergeBrandingResults(
      input.jsAnalysis,
      result,
      input.buttons,
    );
    expect(merged.colors?.accent).toBe("#FF5500");
    expect(merged.colors?.primary).toBe("#6D28D9");
  });

  it("never asks Jev to pick a cookie-consent button", async () => {
    const input = baseInput(new CostTracking());
    input.buttons = [
      { ...input.buttons[0], index: 0, text: "Accept all cookies" },
      { ...input.buttons[1], index: 1, text: "Reject all" },
      { ...input.buttons[0], index: 2, text: "Get started" },
    ];
    expect(Object.keys(buildJevRequest(input).state.buttons as object)).toEqual(
      ["button_2"],
    );

    input.buttons = input.buttons.slice(0, 2);
    const request = buildJevRequest(input);
    expect(request.questions.primary_button).toBeUndefined();
    respondWith(
      jevResponse({ primary_button: undefined, secondary_button: undefined }),
    );
    const result = await enhanceBrandingWithLLM(input);
    expect(result.buttonClassification.primaryButtonIndex).toBe(-1);
  });

  it("stops calling Jev for a minute after repeated failures, then tries again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    mocks.systemOne.mockRejectedValue(new Error("529 high traffic"));

    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }
    expect(mocks.systemOne).toHaveBeenCalledTimes(5);

    // Open: answered by the LLM without waiting on Jev.
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    expect(mocks.systemOne).toHaveBeenCalledTimes(5);
    expect(generateObject).toHaveBeenCalledTimes(6);

    // After the cooldown Jev is tried again, and a success keeps it in use.
    vi.setSystemTime(Date.now() + 61_000);
    mocks.systemOne.mockReset().mockResolvedValue(jevResponse());
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    expect(mocks.systemOne).toHaveBeenCalledTimes(2);
    expect(generateObject).toHaveBeenCalledTimes(6);
  });

  it("reopens on the first failure after the cooldown", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    mocks.systemOne.mockRejectedValue(new Error("503 no healthy upstream"));
    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }

    vi.setSystemTime(Date.now() + 61_000);
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(mocks.systemOne).toHaveBeenCalledTimes(6);
  });

  it("reopens at once after the cooldown even if a call that started earlier succeeded late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T12:00:00Z"));
    let finishSlowCall!: (value: unknown) => void;
    mocks.systemOne.mockImplementationOnce(
      () => new Promise(resolve => (finishSlowCall = resolve)),
    );
    const slow = enhanceBrandingWithLLM(baseInput(new CostTracking()));
    mocks.systemOne.mockRejectedValue(new Error("529 high traffic"));
    for (let i = 0; i < 5; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }
    finishSlowCall(jevResponse());
    await slow;

    vi.setSystemTime(Date.now() + 61_000);
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    // the slow call, five failures, one failure after the cooldown; then open again
    expect(mocks.systemOne).toHaveBeenCalledTimes(7);
  });

  it("does not count unusable answers as failures", async () => {
    mocks.systemOne.mockResolvedValue({
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    for (let i = 0; i < 6; i++) {
      await enhanceBrandingWithLLM(baseInput(new CostTracking()));
    }

    expect(mocks.systemOne).toHaveBeenCalledTimes(6);
  });

  it("falls back to the LLM when Jev's answers have an unexpected shape", async () => {
    respondWith({
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.colorRoles.primaryColor).toBe("#000000");
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithJev",
      "enhanceBrandingWithLLM",
    ]);
  });

  it("drops fallback fonts and unplaced extras once headings and body are covered", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Inter", heading: "Inter" },
    };
    input.jsAnalysis.fonts = [
      { family: "Inter", count: 40 },
      { family: "Segoe UI", count: 20 },
      { family: "Roboto", count: 10 },
      { family: "Canela", count: 5 },
    ];
    respondWith(
      jevResponse({
        font_0_is_brand: { type: "noul", noul: 0.95 },
        font_1_is_brand: { type: "noul", noul: 0.9 },
        font_2_is_brand: { type: "noul", noul: 0.9 },
        font_3_is_brand: { type: "noul", noul: 0.9 },
        font_3_role: {
          type: "choice",
          choice: "unknown",
          probabilities: { unknown: 1 },
          confidence: 0.9,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.cleanedFonts).toEqual([{ family: "Inter", role: "body" }]);
  });

  it("keeps the typography role of a family merged under its spaced name", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = {
      fontFamilies: { primary: "Inter", heading: "CormorantGaramond" },
    };
    input.jsAnalysis.fonts = [
      { family: "Inter", count: 40 },
      { family: "CormorantGaramond", count: 10 },
      { family: "Cormorant Garamond", count: 5 },
      { family: "Open-Sans", count: 3 },
      { family: "Open Sans", count: 2 },
    ];

    const request = buildJevRequest(input);

    expect(request.fonts.map(f => [f.family, f.role])).toEqual([
      ["Inter", "body"],
      ["Cormorant Garamond", "heading"],
      ["Open-Sans", undefined],
      ["Open Sans", undefined],
    ]);
  });

  it("keeps a fallback font the page uses for text, or when it is all there is", async () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.typography = { fontFamilies: { primary: "Arial" } };
    input.jsAnalysis.fonts = [{ family: "Arial", count: 40 }];
    respondWith(jevResponse({ font_0_is_brand: { type: "noul", noul: 0.9 } }));
    expect((await enhanceBrandingWithLLM(input)).cleanedFonts).toEqual([
      { family: "Arial", role: "body" },
    ]);

    const only = baseInput(new CostTracking());
    only.jsAnalysis.fonts = [{ family: "Helvetica", count: 40 }];
    respondWith(
      jevResponse({
        font_0_is_brand: { type: "noul", noul: 0.9 },
        font_0_role: {
          type: "choice",
          choice: "unknown",
          probabilities: { unknown: 1 },
          confidence: 0.9,
        },
      }),
    );
    expect((await enhanceBrandingWithLLM(only)).cleanedFonts).toEqual([
      { family: "Helvetica", role: "unknown" },
    ]);
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

  it("does not pool buttons that differ in shape", async () => {
    const input = baseInput(new CostTracking());
    input.buttons[0].borderRadius = "4px";
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
      borderRadius: "999px",
    });
    respondWith(
      jevResponse({
        primary_button: {
          type: "choice",
          choice: "button_0",
          probabilities: { button_0: 0.48, button_1: 0.04, button_2: 0.48 },
          confidence: 0.35,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.confidence).toBeCloseTo(0.48);
  });

  it("skips a secondary button that looks like the primary, since merge would drop it", async () => {
    const input = baseInput(new CostTracking());
    input.buttons.push({
      ...input.buttons[0],
      index: 2,
      text: "Start free trial",
    });
    respondWith(
      jevResponse({
        secondary_button: {
          type: "choice",
          choice: "button_2",
          probabilities: {
            button_0: 0.1,
            button_1: 0.3,
            button_2: 0.55,
            none: 0.05,
          },
          confidence: 0.5,
        },
      }),
    );

    const result = await enhanceBrandingWithLLM(input);

    expect(result.buttonClassification.secondaryButtonIndex).toBe(1);
    const merged = mergeBrandingResults(
      input.jsAnalysis,
      result,
      input.buttons,
    );
    expect(merged.components?.buttonSecondary?.background).toBe("transparent");
  });

  it("falls back to the LLM when the TypeSafe API errors", async () => {
    mocks.systemOne.mockRejectedValueOnce(new Error("invalid api key"));
    const costTracking = new CostTracking();

    const result = await enhanceBrandingWithLLM(baseInput(costTracking));

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(result.colorRoles.primaryColor).toBe("#000000");
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithLLM",
    ]);
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

  it("keeps unlisted teams off Jev", async () => {
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      teamId: "team-unlisted",
    });

    expect(mocks.systemOne).not.toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("uses Jev for zero-data-retention scrapes and keeps their span unexported", async () => {
    respondWith(jevResponse());
    const withSpan = vi.spyOn(tracer, "withSpan");

    const result = await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      zeroDataRetention: true,
    });

    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
    expect(generateObject).not.toHaveBeenCalled();
    expect(result.logoSelection?.selectedLogoIndex).toBe(1);
    expect(withSpan).toHaveBeenCalledWith(
      "typesafe.systemone",
      expect.any(Function),
      expect.objectContaining({ zeroDataRetention: true }),
    );
    withSpan.mockRestore();
  });

  it("tags the Jev span with the team so spend can be attributed", async () => {
    respondWith(jevResponse());
    const withSpan = vi.spyOn(tracer, "withSpan");

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    const call = withSpan.mock.calls.find(c => c[0] === "typesafe.systemone");
    expect(call?.[2]?.attributes).toMatchObject({
      feature: "branding",
      teamId: "team-jev",
    });
    withSpan.mockRestore();
  });

  it("keeps a listed team on the LLM unless the request asks for fast", async () => {
    for (const mode of [undefined, "auto", "standard"] as const) {
      await enhanceBrandingWithLLM({ ...baseInput(new CostTracking()), mode });
    }
    expect(mocks.systemOne).not.toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(3);

    respondWith(jevResponse());
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      mode: "fast",
    });
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
  });

  it("ignores mode for teams that aren't listed", async () => {
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      teamId: "team-unlisted",
      mode: "fast",
    });
    expect(mocks.systemOne).not.toHaveBeenCalled();

    config.BRANDING_JEV = true;
    respondWith(jevResponse());
    await enhanceBrandingWithLLM({
      ...baseInput(new CostTracking()),
      teamId: "team-unlisted",
      mode: "standard",
    });
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
  });

  it("puts a rollout share of teams on Jev without listing them", async () => {
    const unlisted = { ...baseInput(new CostTracking()), teamId: "team-a" };

    await enhanceBrandingWithLLM(unlisted);
    expect(mocks.systemOne).not.toHaveBeenCalled();

    config.BRANDING_JEV_ROLLOUT_PERCENT = 100;
    respondWith(jevResponse());
    await enhanceBrandingWithLLM(unlisted);
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
  });

  it("stays on the LLM when no TypeSafe key is configured", async () => {
    config.TYPESAFE_API_KEY = undefined;

    await enhanceBrandingWithLLM(baseInput(new CostTracking()));

    expect(mocks.systemOne).not.toHaveBeenCalled();
    expect(generateObject).toHaveBeenCalledTimes(1);
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

  it("sends only well-formed Unicode text", () => {
    // "𝐁" (U+1D401) is a surrogate pair. The branding script truncates button
    // text by code unit, which can leave its first half alone at the end.
    const bold = "\u{1D401}";
    const input = baseInput(new CostTracking());
    input.pageTitle = "a".repeat(199) + bold;
    input.buttons![0].text = "Beyond the Storefront " + bold + "\uD835";
    input.buttons![1].text = "x".repeat(39) + bold;

    const request = buildJevRequest(input);
    const page = request.state.page as Record<string, string>;
    const buttons = request.state.buttons as Record<
      string,
      Record<string, string>
    >;

    // clip() drops a pair it would cut in half rather than keep one half.
    expect(page.title).toBe("a".repeat(199));
    expect(buttons.button_0.text).toBe(
      "Beyond the Storefront " + bold + "\uFFFD",
    );
    // JSON.stringify escapes lone surrogates as \udxxx; none may remain.
    expect(JSON.stringify(request.state)).not.toMatch(/\\ud[89a-f]/i);
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
    expect(cleanFontFamily("system-ui, sans-serif")).toBeUndefined();
    expect(cleanFontFamily("Inter, sans-serif")).toBe("Inter");
    expect(cleanFontFamily("Newsreader Variable")).toBe("Newsreader");
  });

  it("merges a family listed with and without spaces", () => {
    const input = baseInput(new CostTracking());
    input.jsAnalysis.fonts = [
      { family: "CormorantGaramond", count: 10 },
      { family: "Cormorant Garamond", count: 5 },
    ];
    expect(buildJevRequest(input).fonts).toEqual([
      { family: "Cormorant Garamond", count: 15, role: undefined },
    ]);
  });
});
