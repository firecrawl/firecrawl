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
import { compareBrandingAnswers } from "../../../lib/branding/jev-shadow";
import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { BrandingEnhancement } from "../../../lib/branding/schema";
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

const input = (
  costTracking: CostTracking,
  overrides: Partial<BrandingLLMInput> = {},
): BrandingLLMInput => ({
  jsAnalysis: {
    colorScheme: "light",
    colors: {
      primary: "#6D28D9",
      background: "#FFFFFF",
      textPrimary: "#111111",
    },
    images: { logo: "https://acme.test/old-logo.svg" },
    fonts: [{ family: "Inter", count: 40 }],
  },
  buttons: [
    {
      index: 0,
      text: "Get started",
      html: "",
      classes: "btn",
      background: "#6D28D9",
      textColor: "#FFFFFF",
    },
    {
      index: 1,
      text: "Contact sales",
      html: "",
      classes: "btn-outline",
      background: "transparent",
      textColor: "#111111",
      borderColor: "#111111",
    },
  ],
  logoCandidates: [LOGO],
  brandName: "Acme",
  url: "https://acme.test/",
  teamId: "team-other",
  scrapeId: "scrape-1",
  costTracking,
  logger,
  ...overrides,
});

const LLM_ANSWER: BrandingEnhancement = {
  cleanedFonts: [{ family: "Inter", role: "body" }],
  buttonClassification: {
    primaryButtonIndex: 0,
    primaryButtonReasoning: "violet CTA",
    secondaryButtonIndex: 1,
    secondaryButtonReasoning: "outline",
    confidence: 0.9,
  },
  colorRoles: {
    primaryColor: "#6D28D9",
    accentColor: "#6D28D9",
    backgroundColor: "#FFFFFF",
    textPrimary: "#111111",
    confidence: 0.9,
  },
  logoSelection: {
    selectedLogoIndex: 0,
    selectedLogoReasoning: "header logo",
    confidence: 0.9,
  },
};

// Jev agrees on everything except the logo, which it says is not there.
const jevResponse = () => ({
  model: "jev-1.13.0",
  answers: {
    logo: {
      type: "choice",
      choice: "none",
      probabilities: { logo_0: 0.2, none: 0.8 },
      confidence: 0.8,
    },
    primary_button: {
      type: "choice",
      choice: "button_0",
      probabilities: { button_0: 0.9, button_1: 0.1 },
      confidence: 0.9,
    },
    secondary_button: {
      type: "choice",
      choice: "button_1",
      probabilities: { button_0: 0.1, button_1: 0.9, none: 0 },
      confidence: 0.9,
    },
    primary_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.9 },
      confidence: 0.9,
    },
    accent_color: {
      type: "choice",
      choice: "color_0",
      probabilities: { color_0: 0.9 },
      confidence: 0.9,
    },
    background_color: {
      type: "choice",
      choice: "color_1",
      probabilities: { color_1: 0.9 },
      confidence: 0.9,
    },
    text_color: {
      type: "choice",
      choice: "color_2",
      probabilities: { color_2: 0.9 },
      confidence: 0.9,
    },
    font_0_is_brand: { type: "noul", noul: 0.9 },
  },
  usage: { input_tokens: 2000, output_tokens: 60 },
});

const saved = {
  key: config.TYPESAFE_API_KEY,
  teamIds: config.BRANDING_JEV_TEAM_IDS,
  shadow: config.BRANDING_JEV_SHADOW_PERCENT,
};

let attributes: Record<string, unknown>[];

beforeEach(() => {
  config.TYPESAFE_API_KEY = "ts-test";
  config.BRANDING_JEV_TEAM_IDS = ["team-jev"];
  config.BRANDING_JEV_SHADOW_PERCENT = 100;
  mocks.systemOne.mockReset().mockResolvedValue(jevResponse());
  (generateObject as Mock).mockReset().mockResolvedValue({
    object: structuredClone(LLM_ANSWER),
    usage: { inputTokens: 6000, outputTokens: 400 },
  });
  attributes = [];
  vi.spyOn(tracer, "setSpanAttributes").mockImplementation((_span, attrs) => {
    attributes.push(attrs as Record<string, unknown>);
  });
});

afterEach(() => {
  config.TYPESAFE_API_KEY = saved.key;
  config.BRANDING_JEV_TEAM_IDS = saved.teamIds;
  config.BRANDING_JEV_SHADOW_PERCENT = saved.shadow;
  vi.restoreAllMocks();
});

const shadowOutcome = () =>
  attributes.find(a => "branding.shadow.outcome" in a);

describe("Jev branding shadow", () => {
  it("asks Jev in the background and still returns the LLM's answer", async () => {
    const costTracking = new CostTracking();
    const withSpan = vi.spyOn(tracer, "withSpan");

    const result = await enhanceBrandingWithLLM(input(costTracking));

    expect(result).toEqual(LLM_ANSWER);
    await vi.waitFor(() => expect(shadowOutcome()).toBeDefined());
    expect(shadowOutcome()).toMatchObject({
      "branding.shadow.outcome": "compared",
      "branding.shadow.logo_agree": false,
      "branding.shadow.button_primary_agree": true,
      "branding.shadow.button_secondary_agree": true,
      "branding.shadow.color_primary_agree": true,
      "branding.shadow.color_background_agree": true,
      "branding.shadow.fonts_overlap": 1,
    });
    expect(
      attributes.find(a => "branding.shadow.llm_model" in a),
    ).toMatchObject({
      "branding.shadow.llm_model": "gpt-4o",
      "branding.shadow.team_id": "team-other",
    });
    // The shadow's cost is not the scrape's.
    expect(costTracking.calls.map(c => c.metadata.method)).toEqual([
      "enhanceBrandingWithLLM",
    ]);
    const jevSpan = withSpan.mock.calls.find(
      c => c[0] === "typesafe.systemone",
    );
    expect(jevSpan?.[2]?.attributes).toMatchObject({
      "branding.jev.shadow": true,
    });
  });

  it("leaves the caller's profile and answer untouched", async () => {
    const request = input(new CostTracking());
    const profileBefore = structuredClone(request.jsAnalysis);

    const result = await enhanceBrandingWithLLM(request);
    const answerBefore = structuredClone(result);
    await vi.waitFor(() => expect(shadowOutcome()).toBeDefined());

    // Merging Jev's "no logo" would delete images.logo on a shared profile.
    expect(request.jsAnalysis).toEqual(profileBefore);
    expect(result).toEqual(answerBefore);
  });

  it("records a failed Jev call without affecting the response", async () => {
    mocks.systemOne.mockReset().mockRejectedValue(new Error("rate limited"));
    const warn = vi.spyOn(logger, "warn");

    const result = await enhanceBrandingWithLLM(input(new CostTracking()));

    expect(result).toEqual(LLM_ANSWER);
    await vi.waitFor(() =>
      expect(shadowOutcome()).toEqual({
        "branding.shadow.outcome": "jev_failed",
      }),
    );
    // Logged by enhanceBrandingWithJev in shadow mode. A rejected call is
    // handled there, so the shadow's own catch ("Jev branding shadow failed")
    // never runs.
    expect(warn).toHaveBeenCalledWith(
      "Jev branding shadow call failed",
      expect.anything(),
    );
  });

  it("skips zero-data-retention requests", async () => {
    await enhanceBrandingWithLLM(
      input(new CostTracking(), { zeroDataRetention: true }),
    );
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("does nothing at 0%", async () => {
    config.BRANDING_JEV_SHADOW_PERCENT = 0;
    await enhanceBrandingWithLLM(input(new CostTracking()));
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.systemOne).not.toHaveBeenCalled();
  });

  it("does not shadow a request that Jev already answered", async () => {
    await enhanceBrandingWithLLM(
      input(new CostTracking(), { teamId: "team-jev", mode: "fast" }),
    );
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.systemOne).toHaveBeenCalledTimes(1);
    expect(shadowOutcome()).toBeUndefined();
  });
});

describe("comparing branding answers", () => {
  const request = input(new CostTracking());

  it("treats identical answers as agreeing on every field", () => {
    const result = compareBrandingAnswers(request, LLM_ANSWER, LLM_ANSWER);
    expect(result.fields_agreeing).toBe(result.fields_compared);
    expect(result.fields_compared).toBe(7);
  });

  it("counts nearly identical colors as the same and different buttons as not", () => {
    const other: BrandingEnhancement = structuredClone(LLM_ANSWER);
    other.colorRoles.backgroundColor = "#FDFDFD";
    other.buttonClassification.primaryButtonIndex = 1;
    other.buttonClassification.secondaryButtonIndex = 0;

    const result = compareBrandingAnswers(request, LLM_ANSWER, other);

    expect(result.color_background_agree).toBe(true);
    expect(result.button_primary_agree).toBe(false);
    expect(result.button_secondary_agree).toBe(false);
  });

  it("compares fonts after merge, which keeps the page's fonts when an answer has none", () => {
    const noFonts: BrandingEnhancement = {
      ...structuredClone(LLM_ANSWER),
      cleanedFonts: [],
    };

    const result = compareBrandingAnswers(request, noFonts, LLM_ANSWER);

    expect(result.fonts_overlap).toBe(1);
  });

  it("treats buttons that differ only in shape as different", () => {
    const shaped = input(new CostTracking());
    shaped.buttons = [
      { ...shaped.buttons![0], borderRadius: "4px" },
      shaped.buttons![1],
      {
        ...shaped.buttons![0],
        index: 2,
        text: "Start free trial",
        borderRadius: "999px",
      },
    ];
    const pill: BrandingEnhancement = structuredClone(LLM_ANSWER);
    pill.buttonClassification.primaryButtonIndex = 2;

    const result = compareBrandingAnswers(shaped, LLM_ANSWER, pill);

    expect(result.button_primary_agree).toBe(false);
    expect(result.button_secondary_agree).toBe(true);
  });
});
