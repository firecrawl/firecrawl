import { BrandingProfile } from "../../types/branding";
import { LogoCandidate } from "./logo-selector";
import { BrandingEnhancement } from "./schema";
import { ButtonSnapshot, calculateLogoArea } from "./types";
import { logger } from "../logger";

export function mergeBrandingResults(
  js: BrandingProfile,
  llm: BrandingEnhancement,
  buttonSnapshots: ButtonSnapshot[],
  logoCandidates?: LogoCandidate[],
): BrandingProfile {
  const merged: BrandingProfile = { ...js };

  // Handle logo selection only when we had logo candidates; ignore logoSelection when there were none
  const hasLogoCandidates = !!(logoCandidates && logoCandidates.length > 0);
  if (
    hasLogoCandidates &&
    llm.logoSelection &&
    llm.logoSelection.selectedLogoIndex !== undefined
  ) {
    // If LLM explicitly says no logo (returns -1), remove any logo that was set
    if (llm.logoSelection.selectedLogoIndex === -1) {
      if (merged.images) {
        delete merged.images.logo;
        delete merged.images.logoHref;
        delete merged.images.logoAlt;
      }
      (merged as any).__llm_logo_reasoning = {
        selectedIndex: -1,
        reasoning:
          llm.logoSelection.selectedLogoReasoning || "No valid logo found",
        confidence: llm.logoSelection.confidence || 0,
        rejected: true,
        source: "llm",
      };
    }
    // If LLM selected a valid logo index
    else if (
      llm.logoSelection.selectedLogoIndex >= 0 &&
      logoCandidates &&
      logoCandidates.length > 0 &&
      llm.logoSelection.selectedLogoIndex < logoCandidates.length
    ) {
      const selectedLogo = logoCandidates[llm.logoSelection.selectedLogoIndex];
      if (selectedLogo) {
        // Quality checks before accepting the logo
        const confidence = llm.logoSelection.confidence || 0;
        const alt = selectedLogo.alt || "";
        const altLower = alt.toLowerCase().trim();
        const href = selectedLogo.href || "";

        // Red flags: these patterns indicate it's NOT a brand logo
        const isLanguageWord =
          /^(english|español|français|deutsch|italiano|português|中文|日本語|한국어|русский|العربية|en|es|fr|de|it|pt|zh|ja|ko|ru|ar)$/i.test(
            altLower,
          );
        const isCommonMenuWord =
          /^(menu|search|cart|login|signup|register|account|profile|settings|help|support|contact|about|home|shop|store|products|services|blog|news)$/i.test(
            altLower,
          );
        const isUIIcon =
          /search|icon|menu|hamburger|cart|user|bell|notification|settings|close|times/i.test(
            altLower,
          );

        // Check for external links - brand logos should NOT link to external websites
        // Note: External links should already be filtered out in brandingScript.ts
        // This is a minimal safety check - we can't verify external links without page URL
        let isExternalLink = false;
        if (href && href.trim()) {
          const hrefLower = href.toLowerCase().trim();
          // Relative URLs (starting with /) are always internal
          // Full URLs should have been filtered already, but if they got through,
          // we can't verify they're internal without the page URL (window.location not available in Node.js)
          // So we'll only flag known external service patterns that should have been filtered
          if (
            hrefLower.startsWith("http://") ||
            hrefLower.startsWith("https://") ||
            hrefLower.startsWith("//")
          ) {
            // Check for known external service domains (should have been filtered already)
            const externalServiceDomains = [
              "github.com",
              "twitter.com",
              "x.com",
              "facebook.com",
              "linkedin.com",
            ];
            if (
              externalServiceDomains.some(domain => hrefLower.includes(domain))
            ) {
              isExternalLink = true;
            }
            // Note: We can't verify other full URLs without page URL, so we trust
            // that brandingScript.ts already filtered them correctly
          }
        }

        // Check for very small square icons (typical UI icons: 16x16, 20x20, 24x24, etc.)
        const width = selectedLogo.position?.width || 0;
        const height = selectedLogo.position?.height || 0;
        const isSmallSquareIcon =
          Math.abs(width - height) < 5 && width < 40 && width > 0;
        const trustLLMForLogo = confidence >= 0.7;
        const smallSquareIconLikelyUi =
          isSmallSquareIcon &&
          !(trustLLMForLogo && selectedLogo.indicators?.inHeader);

        // Only set logo if:
        // 1. Confidence is good (>= 0.5) OR
        // 2. Logo has very strong indicators (inHeader + hrefMatch + reasonable size)
        // AND no red flags (small square icons are allowed only with strong indicators)
        const area = calculateLogoArea(selectedLogo.position);
        const hasReasonableSize = area >= 500 && area <= 100000;
        const hasStrongIndicators =
          selectedLogo.indicators?.inHeader &&
          selectedLogo.indicators?.hrefMatch &&
          hasReasonableSize;

        const reasoning = llm.logoSelection.selectedLogoReasoning ?? "";
        const isHeuristicOrFallback =
          reasoning.includes("Heuristic") ||
          reasoning.includes("heuristic") ||
          reasoning === "LLM failed" ||
          reasoning.includes("invalid index");

        // Trust LLM logo choice: don't reject for "small square icon" when LLM selected it
        const smallSquareRedFlag =
          smallSquareIconLikelyUi &&
          !hasStrongIndicators &&
          isHeuristicOrFallback;
        const hasRedFlagsWithLLMTrust =
          isLanguageWord ||
          isCommonMenuWord ||
          isUIIcon ||
          smallSquareRedFlag ||
          isExternalLink;
        const shouldIncludeLogoWithLLMTrust =
          !hasRedFlagsWithLLMTrust &&
          (confidence >= 0.5 || (hasStrongIndicators && confidence >= 0.4));

        if (shouldIncludeLogoWithLLMTrust) {
          // Initialize images object if it doesn't exist
          if (!merged.images) {
            merged.images = {};
          }
          merged.images.logo = selectedLogo.src;
          if (selectedLogo.href) {
            merged.images.logoHref = selectedLogo.href;
          } else {
            delete merged.images.logoHref;
          }
          if (selectedLogo.alt) {
            merged.images.logoAlt = selectedLogo.alt;
          } else {
            delete merged.images.logoAlt;
          }
          (merged as any).__llm_logo_reasoning = {
            selectedIndex: llm.logoSelection.selectedLogoIndex,
            reasoning: llm.logoSelection.selectedLogoReasoning,
            confidence: llm.logoSelection.confidence,
            source: isHeuristicOrFallback ? "heuristic" : "llm",
          };
          logger.debug("[branding merge] Logo included", {
            result: "included",
            selectedIndex: llm.logoSelection.selectedLogoIndex,
            source: isHeuristicOrFallback ? "heuristic" : "llm",
            confidence,
            reasoning: (reasoning || "").slice(0, 120),
          });
        } else {
          // Log why we're not including the logo
          let rejectionReason = "Low confidence";
          const redFlagReasons: string[] = [];
          if (hasRedFlagsWithLLMTrust) {
            if (isLanguageWord) redFlagReasons.push("language word");
            if (isCommonMenuWord) redFlagReasons.push("menu word");
            if (isUIIcon) redFlagReasons.push("UI icon");
            if (smallSquareRedFlag) redFlagReasons.push("small square icon");
            if (isExternalLink) redFlagReasons.push("external link");
            rejectionReason = `Red flags detected (${redFlagReasons.join(", ")})`;
          }
          const selectedLogoReasoning = reasoning.trim();
          (merged as any).__llm_logo_reasoning = {
            selectedIndex: llm.logoSelection.selectedLogoIndex,
            reasoning: selectedLogoReasoning
              ? `Logo rejected: ${rejectionReason}. ${selectedLogoReasoning}`
              : `Logo rejected: ${rejectionReason}.`,
            confidence: llm.logoSelection.confidence,
            rejected: true,
            source: isHeuristicOrFallback ? "heuristic" : "llm",
          };
          logger.debug("[branding merge] Logo rejected (override)", {
            result: "rejected",
            selectedIndex: llm.logoSelection.selectedLogoIndex,
            source: isHeuristicOrFallback ? "heuristic" : "llm",
            confidence,
            hasRedFlags: hasRedFlagsWithLLMTrust,
            redFlagReasons: redFlagReasons.length ? redFlagReasons : undefined,
            confidenceOk:
              confidence >= 0.5 || (hasStrongIndicators && confidence >= 0.4),
            isHeuristicOrFallback,
            smallSquareRedFlag,
            reasoning: (reasoning || "").slice(0, 120),
          });
        }
      }
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
        borderRadiusCorners: primaryBtn.borderRadiusCorners,
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
          borderRadiusCorners: secondaryBtn.borderRadiusCorners,
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
