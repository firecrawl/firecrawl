import { vi, describe, it, expect } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn().mockRejectedValue(new Error("connection reset")),
}));
vi.mock("../../../lib/generic-ai", () => ({
  getModel: vi.fn().mockReturnValue({}),
}));
vi.mock("../../../services/sentry", () => ({
  captureExceptionWithZdrCheck: vi.fn(),
}));

import { enhanceBrandingWithLLM } from "../../../lib/branding/llm";
import { mergeBrandingResults } from "../../../lib/branding/merge";
import { logger } from "../../../lib/logger";

const CANDIDATES = [
  {
    src: "https://example.com/logo.svg",
    alt: "Example logo",
    isSvg: true,
    isVisible: true,
    location: "header" as const,
    position: { top: 10, left: 10, width: 140, height: 40 },
    indicators: {
      inHeader: true,
      altMatch: true,
      srcMatch: true,
      classMatch: false,
      hrefMatch: true,
    },
    href: "/",
    source: "header a img",
  },
];

describe("LLM failure fallback", () => {
  it("omits logoSelection, personality and designSystem on failure", async () => {
    const result = await enhanceBrandingWithLLM({
      jsAnalysis: {},
      buttons: [],
      logoCandidates: CANDIDATES,
      url: "https://example.com",
      logger,
    });

    expect(result.logoSelection).toBeUndefined();
    expect(result.personality).toBeUndefined();
    expect(result.designSystem).toBeUndefined();
    expect(result.buttonClassification.primaryButtonReasoning).toBe(
      "LLM failed",
    );
  });

  it("merge keeps the heuristic logo pick and stamps no personality", () => {
    // Shape the transformer produces when it restores the heuristic after an
    // absent LLM logoSelection.
    const merged = mergeBrandingResults(
      { images: {} },
      {
        cleanedFonts: [],
        buttonClassification: {
          primaryButtonIndex: -1,
          primaryButtonReasoning: "LLM failed",
          secondaryButtonIndex: -1,
          secondaryButtonReasoning: "LLM failed",
          confidence: 0,
        },
        colorRoles: {
          primaryColor: "",
          accentColor: "",
          backgroundColor: "",
          textPrimary: "",
          confidence: 0,
        },
        logoSelection: {
          selectedLogoIndex: 0,
          selectedLogoReasoning: "Heuristic fallback: strong indicators",
          confidence: 0.8,
        },
      },
      [],
      CANDIDATES,
    );

    expect(merged.images?.logo).toBe("https://example.com/logo.svg");
    expect((merged as any).personality).toBeUndefined();
    expect((merged as any).designSystem).toBeUndefined();
  });
});
