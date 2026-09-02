import { config } from "../config";
import type { TeamFlags } from "../controllers/v1/types";
import { getACUCTeam } from "../controllers/auth";
import { logger } from "./logger";

/**
 * Raster image OCR rides on FirePDF and is rolled out per team through the
 * `imageOcr` team flag. Every entry point (URL-extension routing, the browser
 * handoff, parse uploads) consults this one check, so a team without the flag
 * gets exactly the pre-existing behaviour.
 */
export function isImageOcrEnabled(
  teamFlags: TeamFlags | null | undefined,
): boolean {
  return !!config.FIRE_PDF_BASE_URL && teamFlags?.imageOcr === true;
}

/**
 * Resolves the per-scrape decision. Single scrapes and parse uploads carry
 * the authenticated team's flags in their internalOptions; batch-scrape and
 * crawl jobs do not, so for those the flags come from the cached team ACUC
 * (the same lookup the crawler already does per job). Any lookup failure
 * keeps the pre-existing behaviour rather than failing the scrape.
 */
export async function resolveImageOcrEnabled(
  teamId: string | undefined,
  teamFlags: TeamFlags | null | undefined,
): Promise<boolean> {
  if (!config.FIRE_PDF_BASE_URL) return false;
  if (teamFlags !== undefined) return isImageOcrEnabled(teamFlags);
  if (!teamId) return false;
  try {
    const acuc = await getACUCTeam(teamId);
    return isImageOcrEnabled(acuc?.flags ?? null);
  } catch (error) {
    logger.warn("Failed to resolve team flags for image OCR; leaving it off", {
      teamId,
      error,
    });
    return false;
  }
}
