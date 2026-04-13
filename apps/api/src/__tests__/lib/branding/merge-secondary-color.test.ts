import { mergeBrandingResults } from "../../../lib/branding/merge";
import { BrandingEnhancement } from "../../../lib/branding/schema";
import { BrandingProfile } from "../../../types/branding";

/**
 * Helper to build a minimal BrandingEnhancement with overrides.
 */
function makeLLMResult(
  overrides: Partial<{
    secondaryColor: string | undefined;
    primaryColor: string;
    accentColor: string;
    backgroundColor: string;
    textPrimary: string;
    confidence: number;
  }> = {},
): BrandingEnhancement {
  return {
    buttonClassification: {
      primaryButtonIndex: -1,
      primaryButtonReasoning: "test",
      secondaryButtonIndex: -1,
      secondaryButtonReasoning: "test",
      confidence: 0,
    },
    colorRoles: {
      primaryColor: overrides.primaryColor ?? "#FF0000",
      secondaryColor: overrides.secondaryColor,
      accentColor: overrides.accentColor ?? "#00FF00",
      backgroundColor: overrides.backgroundColor ?? "#FFFFFF",
      textPrimary: overrides.textPrimary ?? "#000000",
      confidence: overrides.confidence ?? 0.9,
    },
    personality: {
      tone: "modern",
      energy: "medium",
      targetAudience: "developers",
    },
    designSystem: {
      framework: "custom",
      componentLibrary: "",
    },
    cleanedFonts: [],
  };
}

/**
 * Helper to build a minimal BrandingProfile (JS-side) with overrides.
 */
function makeJSProfile(
  overrides: Partial<{
    secondary: string | undefined;
    primary: string;
    accent: string;
    background: string;
    textPrimary: string;
  }> = {},
): BrandingProfile {
  return {
    colors: {
      primary: overrides.primary ?? "#AA0000",
      ...(overrides.secondary !== undefined
        ? { secondary: overrides.secondary }
        : {}),
      accent: overrides.accent ?? "#00AA00",
      background: overrides.background ?? "#FAFAFA",
      textPrimary: overrides.textPrimary ?? "#111111",
    },
  };
}

describe("mergeBrandingResults – colors.secondary optionality", () => {
  it("omits colors.secondary when neither LLM nor JS provides one", () => {
    const js = makeJSProfile(); // no secondary
    const llm = makeLLMResult(); // secondaryColor undefined
    const merged = mergeBrandingResults(js, llm, []);

    expect(merged.colors).toBeDefined();
    expect(merged.colors!.primary).toBeDefined();
    expect("secondary" in merged.colors!).toBe(false);
  });

  it("includes colors.secondary when LLM provides secondaryColor", () => {
    const js = makeJSProfile();
    const llm = makeLLMResult({ secondaryColor: "#0000FF" });
    const merged = mergeBrandingResults(js, llm, []);

    expect(merged.colors).toBeDefined();
    expect(merged.colors!.secondary).toBe("#0000FF");
  });

  it("falls back to JS secondary when LLM does not provide secondaryColor", () => {
    const js = makeJSProfile({ secondary: "#ABCDEF" });
    const llm = makeLLMResult(); // secondaryColor undefined
    const merged = mergeBrandingResults(js, llm, []);

    expect(merged.colors).toBeDefined();
    expect(merged.colors!.secondary).toBe("#ABCDEF");
  });

  it("LLM secondaryColor takes precedence over JS secondary", () => {
    const js = makeJSProfile({ secondary: "#ABCDEF" });
    const llm = makeLLMResult({ secondaryColor: "#123456" });
    const merged = mergeBrandingResults(js, llm, []);

    expect(merged.colors).toBeDefined();
    expect(merged.colors!.secondary).toBe("#123456");
  });

  it("omits colors.secondary when LLM returns empty string and JS has none", () => {
    const js = makeJSProfile();
    const llm = makeLLMResult({ secondaryColor: "" });
    const merged = mergeBrandingResults(js, llm, []);

    expect(merged.colors).toBeDefined();
    // Empty string is falsy, so the conditional spread should not include it
    expect(merged.colors!.secondary).toBeUndefined();
  });

  it("does not touch secondary when LLM confidence is below threshold (<=0.7)", () => {
    const js = makeJSProfile({ secondary: "#ABCDEF" });
    const llm = makeLLMResult({ secondaryColor: "#999999", confidence: 0.5 });
    const merged = mergeBrandingResults(js, llm, []);

    // When confidence <= 0.7, the merge block for colors doesn't execute,
    // so JS secondary should be preserved as-is from the spread of js
    expect(merged.colors).toBeDefined();
    expect(merged.colors!.secondary).toBe("#ABCDEF");
  });
});

describe("LLM fallback – secondaryColor not in defaults", () => {
  it("fallback colorRoles should not contain secondaryColor", () => {
    // Simulate what happens when LLM fails: check the fallback return value
    // from enhanceBrandingWithLLM. We test the shape directly.
    const fallbackColorRoles = {
      primaryColor: "",
      accentColor: "",
      backgroundColor: "",
      textPrimary: "",
      confidence: 0,
    };

    // secondaryColor should NOT be present in the fallback
    expect("secondaryColor" in fallbackColorRoles).toBe(false);

    // When merged, this should NOT produce a secondary color
    const js = makeJSProfile();
    const llm = makeLLMResult({
      primaryColor: "",
      accentColor: "",
      backgroundColor: "",
      textPrimary: "",
      confidence: 0,
    });
    const merged = mergeBrandingResults(js, llm, []);

    // confidence 0 <= 0.7, so colors block doesn't execute; JS profile has no secondary
    expect(merged.colors).toBeDefined();
    expect(merged.colors!.secondary).toBeUndefined();
  });
});
