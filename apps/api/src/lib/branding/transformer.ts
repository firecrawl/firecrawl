import { processRawBranding } from "./processor";
import { BrandingProfile } from "../../types/branding";
import { enhanceBrandingWithLLM } from "./llm";
import { Meta } from "../../scraper/scrapeURL";
import { Document } from "../../controllers/v2/types";
import { BrandingScriptReturn, ButtonSnapshot } from "./types";
import { mergeBrandingResults } from "./merge";

export async function brandingTransformer(
  meta: Meta,
  document: Document,
  rawBranding: BrandingScriptReturn,
): Promise<BrandingProfile> {
  let jsBranding = processRawBranding(rawBranding);

  if (!jsBranding) {
    return {};
  }

  let brandingProfile: BrandingProfile = jsBranding;

  try {
    meta.logger.info("Enhancing branding with LLM...");

    const buttonSnapshots: ButtonSnapshot[] =
      (jsBranding as any).__button_snapshots || [];

    const logoCandidates = rawBranding.logoCandidates || [];
    const brandName = rawBranding.brandName;
    const backgroundCandidates = rawBranding.backgroundCandidates || [];

    // Optimize logo candidates: limit to top 15, prioritize by indicators
    const optimizedCandidates = logoCandidates
      .sort((a, b) => {
        // Score candidates: higher score = better
        const scoreA =
          (a.indicators.inHeader ? 10 : 0) +
          (a.indicators.hrefMatch ? 8 : 0) + // href="/" is strong indicator
          (a.isVisible ? 5 : 0) +
          (a.indicators.altMatch ? 3 : 0) +
          (a.indicators.srcMatch ? 2 : 0) +
          (a.indicators.classMatch ? 2 : 0) +
          (a.location === "header" ? 5 : 0);
        const scoreB =
          (b.indicators.inHeader ? 10 : 0) +
          (b.indicators.hrefMatch ? 8 : 0) + // href="/" is strong indicator
          (b.isVisible ? 5 : 0) +
          (b.indicators.altMatch ? 3 : 0) +
          (b.indicators.srcMatch ? 2 : 0) +
          (b.indicators.classMatch ? 2 : 0) +
          (b.location === "header" ? 5 : 0);
        return scoreB - scoreA;
      })
      .slice(0, 15); // Limit to top 15 candidates

    meta.logger.info(
      `Sending ${buttonSnapshots.length} buttons and ${optimizedCandidates.length} logo candidates (from ${logoCandidates.length} total) to LLM for classification`,
    );

    const llmEnhancement = await enhanceBrandingWithLLM({
      jsAnalysis: jsBranding,
      buttons: buttonSnapshots,
      logoCandidates:
        optimizedCandidates.length > 0 ? optimizedCandidates : undefined,
      brandName,
      backgroundCandidates:
        backgroundCandidates.length > 0 ? backgroundCandidates : undefined,
      screenshot: document.screenshot,
      url: document.url || meta.url,
    });

    meta.logger.info("LLM enhancement complete", {
      primary_btn_index: llmEnhancement.buttonClassification.primaryButtonIndex,
      secondary_btn_index:
        llmEnhancement.buttonClassification.secondaryButtonIndex,
      button_confidence: llmEnhancement.buttonClassification.confidence,
      color_confidence: llmEnhancement.colorRoles.confidence,
      logo_selected_index: llmEnhancement.logoSelection?.selectedLogoIndex,
      logo_confidence: llmEnhancement.logoSelection?.confidence,
    });

    brandingProfile = mergeBrandingResults(
      jsBranding,
      llmEnhancement,
      buttonSnapshots,
      logoCandidates.length > 0 ? logoCandidates : undefined,
    );
  } catch (error) {
    meta.logger.error(
      "LLM branding enhancement failed, using JS analysis only",
      { error },
    );
    brandingProfile = jsBranding;
  }

  if (process.env.DEBUG_BRANDING !== "true") {
    delete (brandingProfile as any).__button_snapshots;
  }

  return brandingProfile;
}
