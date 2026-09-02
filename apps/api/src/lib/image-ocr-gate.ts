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

/** Per-scrape gate: resolved lazily on first call and memoized. */
export type ImageOcrGate = () => Promise<boolean>;

/**
 * Builds the per-scrape gate. Single scrapes and parse uploads carry the
 * authenticated team's flags in their internalOptions and resolve without any
 * I/O; batch-scrape and crawl jobs do not, so for those the flags come from
 * the cached team ACUC. The lookup is deferred until a caller actually needs
 * the answer (an image-extension URL, an image handoff, the image engine) and
 * memoized, so the ordinary HTML documents that make up almost every crawl
 * never pay for it. Any lookup failure keeps the pre-existing behaviour.
 */
export function imageOcrGate(
  teamId: string | undefined,
  teamFlags: TeamFlags | null | undefined,
): ImageOcrGate {
  let pending: Promise<boolean> | undefined;
  return () => {
    pending ??= resolveImageOcrEnabled(teamId, teamFlags);
    return pending;
  };
}

async function resolveImageOcrEnabled(
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
