import { processRawBranding } from "./processor";
import { config } from "../../config";
import { BrandingProfile } from "../../types/branding";
import { enhanceBrandingWithLLM } from "./llm";
import { Meta } from "../../scraper/scrapeURL";
import { Document } from "../../controllers/v2/types";
import { BrandingScriptReturn, ButtonSnapshot } from "./types";
import { mergeBrandingResults } from "./merge";
import {
  selectLogoWithConfidence,
  getTopCandidatesForLLM,
} from "./logo-selector";
import { extractHeaderHtmlChunk } from "./extractHeaderHtmlChunk";

function isDebugBrandingEnabled(meta: Meta): boolean {
  return (
    config.DEBUG_BRANDING === true ||
    meta.internalOptions.teamFlags?.debugBranding === true
  );
}

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

  // Declare variables outside try block for catch block access
  const buttonSnapshots: ButtonSnapshot[] =
    (jsBranding as any).__button_snapshots || [];
  const inputSnapshots = (jsBranding as any).__input_snapshots || [];
  const logoCandidates = rawBranding.logoCandidates || [];
  const brandName = rawBranding.brandName;
  const backgroundCandidates = rawBranding.backgroundCandidates || [];

  // Initialize metadata tracking variables
  let llmButtonClassificationSucceeded = false;
  let llmLogoSelectionSucceeded = false;
  let logoSelectionFinalSource: "llm" | "heuristic" | "fallback" | "none" =
    "none";
  let logoSelectionError: string | undefined = undefined;
  let heuristicResult: ReturnType<typeof selectLogoWithConfidence> | null =
    null;

  try {
    // TIER 1: Use smart heuristics to get initial selection (passed to LLM for confirm/override)
    heuristicResult =
      logoCandidates.length > 0
        ? selectLogoWithConfidence(logoCandidates, brandName)
        : null;

    if (logoCandidates.length === 0) {
      meta.logger.warn("No logo candidates found", { brandName });
    } else {
      meta.logger.info("Logo heuristic selection", {
        candidatesCount: logoCandidates.length,
        selectedIndex: heuristicResult?.selectedIndex,
        confidence: heuristicResult?.confidence,
        method: heuristicResult?.method,
      });
    }

    // Always send logo candidates to the LLM when we have any (confirm or override heuristic)
    // Filter to top 20 candidates for LLM (keeps strong body candidates like alt="X logo" + document.images)
    const { filteredCandidates, indexMap } =
      logoCandidates.length > 0
        ? getTopCandidatesForLLM(logoCandidates, 20)
        : { filteredCandidates: [], indexMap: new Map<number, number>() };

    // Heuristic's pick in filtered-list index space (so prompt can say "heuristic picked #N")
    let heuristicLogoPick:
      | {
          selectedIndexInFilteredList: number;
          confidence: number;
          reasoning: string;
        }
      | undefined;
    if (heuristicResult && filteredCandidates.length > 0) {
      let heuristicFilteredIndex = -1;
      for (const [filteredIdx, originalIdx] of indexMap) {
        if (originalIdx === heuristicResult.selectedIndex) {
          heuristicFilteredIndex = filteredIdx;
          break;
        }
      }
      if (heuristicFilteredIndex >= 0) {
        heuristicLogoPick = {
          selectedIndexInFilteredList: heuristicFilteredIndex,
          confidence: heuristicResult.confidence,
          reasoning: heuristicResult.reasoning,
        };
      }
    }

    // Limit buttons to top 12 most relevant ones to reduce prompt size
    // Prioritize buttons with CTA indicators, vibrant colors, or common CTA text
    let limitedButtons = buttonSnapshots;
    const buttonIndexMap = new Map<number, number>(); // LLM index -> original index

    if (buttonSnapshots.length > 12) {
      const scored = buttonSnapshots
        .map((btn, idx) => {
          let score = 0;
          const text = (btn.text || "").toLowerCase();
          const bgColor = btn.background || "";

          // Score common CTA text (higher priority)
          const primaryCtaKeywords = [
            "get started",
            "sign up",
            "sign in",
            "login",
            "register",
            "read",
            "learn",
            "download",
            "buy",
            "shop",
          ];
          if (primaryCtaKeywords.some(keyword => text.includes(keyword)))
            score += 100;

          // Score secondary CTA text
          const secondaryCtaKeywords = ["try", "start", "view", "explore"];
          if (secondaryCtaKeywords.some(keyword => text.includes(keyword)))
            score += 50;

          // Score vibrant colors (not white/transparent/gray)
          if (
            bgColor &&
            !bgColor.match(
              /transparent|white|#fff|#ffffff|gray|grey|#f[0-9a-f]{5}/i,
            )
          ) {
            score += 30;
          }

          return { btn, originalIdx: idx, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);

      limitedButtons = scored.map(item => item.btn);

      // Create index map: LLM index (0-11) -> original index
      scored.forEach((item, llmIdx) => {
        buttonIndexMap.set(llmIdx, item.originalIdx);
      });
    } else {
      // No filtering needed, create identity map
      buttonSnapshots.forEach((_, idx) => {
        buttonIndexMap.set(idx, idx);
      });
    }

    meta.logger.info("Button filtering for LLM", {
      totalButtons: buttonSnapshots.length,
      limitedButtons: limitedButtons.length,
    });

    // When no logo candidates, pass a header/nav HTML chunk so the LLM has fallback context (brand name, "logo exists but not captured")
    const headerHtmlChunk =
      logoCandidates.length === 0 &&
      document.html &&
      typeof document.html === "string"
        ? extractHeaderHtmlChunk(document.html)
        : undefined;

    const sendingLogoCandidates = filteredCandidates.length > 0;

    // TIER 2: Call LLM (always with logo candidates when we have any; heuristic suggestion passed for confirm/override)
    const finalUrl = rawBranding.pageUrl || document.url || meta.url;
    const llmEnhancement = await enhanceBrandingWithLLM({
      jsAnalysis: jsBranding,
      buttons: limitedButtons,
      logoCandidates: sendingLogoCandidates ? filteredCandidates : undefined,
      brandName,
      pageTitle: rawBranding.pageTitle,
      pageUrl: rawBranding.pageUrl,
      backgroundCandidates:
        backgroundCandidates.length > 0 ? backgroundCandidates : undefined,
      screenshot: document.screenshot,
      url: finalUrl || "",
      headerHtmlChunk: headerHtmlChunk || undefined,
      favicon: brandingProfile.images?.favicon ?? undefined,
      ogImage: brandingProfile.images?.ogImage ?? undefined,
      heuristicLogoPick,
      teamId: meta.internalOptions.teamId,
      teamFlags: meta.internalOptions.teamFlags,
    });

    // Track LLM success/failure status (will be updated after all processing)
    llmButtonClassificationSucceeded =
      llmEnhancement.buttonClassification.primaryButtonReasoning !==
        "LLM failed" && llmEnhancement.buttonClassification.confidence > 0;

    // Capture raw AI response for logoSelection (before any mapping/heuristic overwrite) for debugging
    const rawLogoSelectionFromLLM =
      llmEnhancement.logoSelection != null
        ? {
            selectedLogoIndex: llmEnhancement.logoSelection.selectedLogoIndex,
            selectedLogoReasoning:
              llmEnhancement.logoSelection.selectedLogoReasoning ?? undefined,
            confidence: llmEnhancement.logoSelection.confidence,
          }
        : undefined;

    // When there are no logo candidates, ignore any logoSelection from the LLM so result is consistent
    if (logoCandidates.length === 0 && llmEnhancement.logoSelection != null) {
      delete (llmEnhancement as { logoSelection?: unknown }).logoSelection;
    }

    // Map LLM's filtered index back to original index for logos (when we sent candidates)
    if (llmEnhancement.logoSelection && indexMap.size > 0) {
      const llmFilteredIndex = llmEnhancement.logoSelection.selectedLogoIndex;
      const llmOriginalIndex = indexMap.get(llmFilteredIndex);

      if (llmOriginalIndex !== undefined) {
        // Update the selection with the original index
        llmEnhancement.logoSelection.selectedLogoIndex = llmOriginalIndex;
        meta.logger.info("Logo index mapped (LLM saw filtered list)", {
          llmFilteredIndex: llmFilteredIndex,
          originalIndex: llmOriginalIndex,
          note:
            "LLM said #" +
            llmFilteredIndex +
            " in filtered list → same logo at index " +
            llmOriginalIndex +
            " in full candidates",
        });
      } else if (llmFilteredIndex >= 0) {
        // LLM returned index not in our filtered list - fallback to heuristic
        meta.logger.warn(
          "LLM returned invalid logo index, falling back to heuristic",
          {
            llmFilteredIndex,
            indexMapSize: indexMap.size,
            validIndices: Array.from(indexMap.keys()),
            heuristicIndex: heuristicResult?.selectedIndex,
          },
        );
        if (heuristicResult) {
          llmEnhancement.logoSelection = {
            selectedLogoIndex: heuristicResult.selectedIndex,
            selectedLogoReasoning: `Heuristic fallback (LLM returned invalid index): ${heuristicResult.reasoning}`,
            confidence: Math.max(heuristicResult.confidence - 0.1, 0.3),
          };
        } else {
          llmEnhancement.logoSelection = {
            selectedLogoIndex: -1,
            selectedLogoReasoning:
              "No valid logo found - LLM returned invalid index and no heuristic result available",
            confidence: 0,
          };
        }
      }
      // llmFilteredIndex === -1: LLM said "no good logo", keep selectedLogoIndex -1
    }

    // Map LLM's button indices back to original indices
    if (llmEnhancement.buttonClassification) {
      const llmPrimaryIdx =
        llmEnhancement.buttonClassification.primaryButtonIndex;
      const llmSecondaryIdx =
        llmEnhancement.buttonClassification.secondaryButtonIndex;

      if (llmPrimaryIdx >= 0) {
        const originalPrimaryIdx = buttonIndexMap.get(llmPrimaryIdx);
        if (originalPrimaryIdx !== undefined) {
          llmEnhancement.buttonClassification.primaryButtonIndex =
            originalPrimaryIdx;
        }
      }

      if (llmSecondaryIdx >= 0) {
        const originalSecondaryIdx = buttonIndexMap.get(llmSecondaryIdx);
        if (originalSecondaryIdx !== undefined) {
          llmEnhancement.buttonClassification.secondaryButtonIndex =
            originalSecondaryIdx;
        }
      }
    }

    // Trust LLM logo selection when valid; no override from heuristic.
    if (
      heuristicResult &&
      logoCandidates.length > 0 &&
      !llmEnhancement.logoSelection
    ) {
      // LLM didn't return logo selection - fallback to heuristic
      meta.logger.warn("LLM didn't return logo selection, using heuristic");
      llmEnhancement.logoSelection = {
        selectedLogoIndex: heuristicResult.selectedIndex,
        selectedLogoReasoning: `Heuristic fallback: ${heuristicResult.reasoning}`,
        confidence: Math.max(heuristicResult.confidence - 0.1, 0.3),
      };
    }

    // Determine final logo selection source after all processing (trust LLM when it picked a logo)
    if (llmEnhancement.logoSelection) {
      const reasoning =
        llmEnhancement.logoSelection.selectedLogoReasoning ?? "";
      const trustLLMChoice =
        reasoning.includes("LLM picked worse logo") ||
        reasoning.includes("Heuristic preferred over LLM");
      const isInvalidIndexFallback =
        reasoning.includes("LLM returned invalid index") ||
        reasoning.includes("invalid index");
      const isHeuristicFallback =
        reasoning.includes("Heuristic fallback") ||
        reasoning.includes("Heuristic preferred") ||
        isInvalidIndexFallback;
      if (
        trustLLMChoice ||
        (reasoning !== "LLM failed" && !isHeuristicFallback)
      ) {
        llmLogoSelectionSucceeded = true;
        logoSelectionFinalSource = "llm";
      } else if (
        (reasoning.includes("Heuristic") || reasoning.includes("heuristic")) &&
        !(
          isInvalidIndexFallback &&
          llmEnhancement.logoSelection?.selectedLogoIndex === -1
        )
      ) {
        logoSelectionFinalSource = "heuristic";
        if (isInvalidIndexFallback) {
          logoSelectionError = "LLM returned invalid logo index";
        }
      } else {
        logoSelectionFinalSource = "fallback";
        logoSelectionError = isInvalidIndexFallback
          ? "LLM returned invalid logo index"
          : reasoning;
      }
    } else if (logoCandidates.length === 0) {
      logoSelectionFinalSource = "none";
    } else {
      logoSelectionFinalSource = "fallback";
      logoSelectionError = "LLM did not return logo selection";
    }

    meta.logger.info("Branding enhancement complete", {
      primary_btn_index: llmEnhancement.buttonClassification.primaryButtonIndex,
      secondary_btn_index:
        llmEnhancement.buttonClassification.secondaryButtonIndex,
      button_confidence: llmEnhancement.buttonClassification.confidence,
      color_confidence: llmEnhancement.colorRoles.confidence,
      logo_selected_index: llmEnhancement.logoSelection?.selectedLogoIndex,
      logo_confidence: llmEnhancement.logoSelection?.confidence,
      logo_selection_method:
        logoCandidates.length > 0
          ? llmEnhancement.logoSelection
            ? "llm-validated"
            : "heuristic-fallback"
          : "none",
      llm_called_for_logo: sendingLogoCandidates,
    });

    brandingProfile = mergeBrandingResults(
      jsBranding,
      llmEnhancement,
      buttonSnapshots,
      logoCandidates.length > 0 ? logoCandidates : undefined,
    );

    // Add LLM metadata for evals (rawLogoSelection = exact AI response for debugging)
    (brandingProfile as any).__llm_metadata = {
      logoSelection: {
        llmCalled: sendingLogoCandidates,
        llmSucceeded: llmLogoSelectionSucceeded,
        finalSource: logoSelectionFinalSource,
        error: logoSelectionError,
        rawLogoSelection: rawLogoSelectionFromLLM,
      },
      buttonClassification: {
        llmCalled: buttonSnapshots.length > 0,
        llmSucceeded: llmButtonClassificationSucceeded,
        error:
          !llmButtonClassificationSucceeded &&
          llmEnhancement.buttonClassification.primaryButtonReasoning ===
            "LLM failed"
            ? "LLM call failed or returned fallback values"
            : undefined,
      },
    };

    meta.logger.info("Input fields detected", {
      count: inputSnapshots.length,
      types: inputSnapshots.map((i: any) => i.type).slice(0, 10),
    });
  } catch (error) {
    meta.logger.error(
      "LLM branding enhancement failed, using JS analysis only",
      { error },
    );
    brandingProfile = jsBranding;

    // Add error metadata
    (brandingProfile as any).__llm_metadata = {
      logoSelection: {
        llmCalled: logoCandidates.length > 0,
        llmSucceeded: false,
        finalSource: heuristicResult ? "heuristic" : "none",
        error: error instanceof Error ? error.message : String(error),
      },
      buttonClassification: {
        llmCalled: buttonSnapshots.length > 0,
        llmSucceeded: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (!isDebugBrandingEnabled(meta)) {
    delete (brandingProfile as any).__button_snapshots;
    delete (brandingProfile as any).__input_snapshots;
    delete (brandingProfile as any).__logo_candidates;
    delete (brandingProfile as any).__framework_hints;
  }

  return brandingProfile;
}
