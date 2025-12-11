import { BrandingProfile } from "../../types/branding";
import { BrandingEnhancement } from "./schema";
import { ButtonSnapshot } from "./types";

export function mergeBrandingResults(
  js: BrandingProfile,
  llm: BrandingEnhancement,
  buttonSnapshots: ButtonSnapshot[],
  logoCandidates?: Array<{
    src: string;
    alt: string;
    isSvg: boolean;
    isVisible: boolean;
    location: "header" | "body";
    position: { top: number; left: number; width: number; height: number };
    indicators: {
      inHeader: boolean;
      altMatch: boolean;
      srcMatch: boolean;
      classMatch: boolean;
    };
    source: string;
  }>,
): BrandingProfile {
  const merged: BrandingProfile = { ...js };

  // Use LLM-selected logo if available
  if (
    llm.logoSelection &&
    llm.logoSelection.selectedLogoIndex !== undefined &&
    llm.logoSelection.selectedLogoIndex >= 0 &&
    logoCandidates &&
    logoCandidates.length > 0 &&
    llm.logoSelection.selectedLogoIndex < logoCandidates.length
  ) {
    const selectedLogo = logoCandidates[llm.logoSelection.selectedLogoIndex];
    if (selectedLogo) {
      // Initialize images object if it doesn't exist
      if (!merged.images) {
        merged.images = {};
      }
      merged.images.logo = selectedLogo.src;
      (merged as any).__llm_logo_reasoning = {
        selectedIndex: llm.logoSelection.selectedLogoIndex,
        reasoning: llm.logoSelection.selectedLogoReasoning,
        confidence: llm.logoSelection.confidence,
      };
    }
  }

  if (buttonSnapshots.length > 0) {
    const primaryIdx = llm.buttonClassification.primaryButtonIndex;
    const secondaryIdx = llm.buttonClassification.secondaryButtonIndex;

    (merged as any).__llm_button_reasoning = {
      primary: {
        index: primaryIdx,
        text: primaryIdx >= 0 ? buttonSnapshots[primaryIdx]?.text : "N/A",
        reasoning: llm.buttonClassification.primaryButtonReasoning,
      },
      secondary: {
        index: secondaryIdx,
        text: secondaryIdx >= 0 ? buttonSnapshots[secondaryIdx]?.text : "N/A",
        reasoning: llm.buttonClassification.secondaryButtonReasoning,
      },
      confidence: llm.buttonClassification.confidence,
    };
  }

  if (llm.buttonClassification.confidence > 0.5 && buttonSnapshots.length > 0) {
    const primaryIdx = llm.buttonClassification.primaryButtonIndex;
    const secondaryIdx = llm.buttonClassification.secondaryButtonIndex;

    if (primaryIdx >= 0 && primaryIdx < buttonSnapshots.length) {
      const primaryBtn = buttonSnapshots[primaryIdx];
      if (!merged.components) merged.components = {};
      merged.components.buttonPrimary = {
        background: primaryBtn.background,
        textColor: primaryBtn.textColor,
        borderColor: primaryBtn.borderColor || undefined,
        borderRadius: primaryBtn.borderRadius || "0px",
        shadow: primaryBtn.shadow || undefined,
      };
    }

    if (secondaryIdx >= 0 && secondaryIdx < buttonSnapshots.length) {
      const secondaryBtn = buttonSnapshots[secondaryIdx];
      const primaryBtn = buttonSnapshots[primaryIdx];

      if (!primaryBtn || secondaryBtn.background !== primaryBtn.background) {
        if (!merged.components) merged.components = {};
        merged.components.buttonSecondary = {
          background: secondaryBtn.background,
          textColor: secondaryBtn.textColor,
          borderColor: secondaryBtn.borderColor || undefined,
          borderRadius: secondaryBtn.borderRadius || "0px",
          shadow: secondaryBtn.shadow || undefined,
        };
      }
    }
  }

  if (llm.colorRoles.confidence > 0.7) {
    merged.colors = {
      ...merged.colors,
      primary: llm.colorRoles.primaryColor || merged.colors?.primary,
      accent: llm.colorRoles.accentColor || merged.colors?.accent,
      background: llm.colorRoles.backgroundColor || merged.colors?.background,
      textPrimary: llm.colorRoles.textPrimary || merged.colors?.textPrimary,
    };

    // Add LLM-selected colors to debug output
    if ((merged as any).__debug_colors) {
      (merged as any).__debug_colors.llmSelectedColors = {
        primary: llm.colorRoles.primaryColor,
        accent: llm.colorRoles.accentColor,
        background: llm.colorRoles.backgroundColor,
        textPrimary: llm.colorRoles.textPrimary,
        confidence: llm.colorRoles.confidence,
      };
    }
  }

  if (llm.personality) {
    (merged as any).personality = llm.personality;
  }

  if (llm.designSystem) {
    (merged as any).designSystem = llm.designSystem;
  }

  if (llm.cleanedFonts && llm.cleanedFonts.length > 0) {
    merged.fonts = llm.cleanedFonts;

    const cleanFontName = (font: string): string => {
      const fontLower = font.toLowerCase();

      for (const cleanedFont of llm.cleanedFonts) {
        const cleanedLower = cleanedFont.family.toLowerCase();

        if (fontLower === cleanedLower) {
          return cleanedFont.family;
        }

        if (fontLower.includes(cleanedLower)) {
          return cleanedFont.family;
        }

        const nextJsPattern = /^__(.+?)(?:_Fallback)?_[a-f0-9]{8}$/i;
        const match = font.match(nextJsPattern);
        if (match) {
          const extractedName = match[1].toLowerCase();
          if (
            extractedName === cleanedLower ||
            cleanedLower.includes(extractedName)
          ) {
            return cleanedFont.family;
          }
        }
      }

      return font;
    };

    if (merged.typography?.fontStacks) {
      const cleanStack = (
        stack: string[] | undefined,
      ): string[] | undefined => {
        if (!stack) return stack;

        const cleaned = stack.map(cleanFontName);
        const seen = new Set<string>();
        return cleaned.filter(font => {
          if (seen.has(font.toLowerCase())) return false;
          seen.add(font.toLowerCase());
          return true;
        });
      };

      merged.typography.fontStacks = {
        primary: cleanStack(merged.typography.fontStacks.primary),
        heading: cleanStack(merged.typography.fontStacks.heading),
        body: cleanStack(merged.typography.fontStacks.body),
        paragraph: cleanStack(merged.typography.fontStacks.paragraph),
      };
    }

    if (merged.typography?.fontFamilies) {
      const headingFont = llm.cleanedFonts.find(f => f.role === "heading");
      const bodyFont = llm.cleanedFonts.find(f => f.role === "body");
      const displayFont = llm.cleanedFonts.find(f => f.role === "display");
      const primaryFont = bodyFont || llm.cleanedFonts[0];

      if (primaryFont) {
        merged.typography.fontFamilies.primary = primaryFont.family;
      }

      const headingToUse = headingFont || displayFont || primaryFont;
      if (headingToUse) {
        merged.typography.fontFamilies.heading = headingToUse.family;
      }
    }
  }

  (merged as any).confidence = {
    buttons: llm.buttonClassification.confidence,
    colors: llm.colorRoles.confidence,
    overall:
      (llm.buttonClassification.confidence + llm.colorRoles.confidence) / 2,
  };

  return merged;
}
