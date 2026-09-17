import { config } from "../config";
import type { TeamFlags } from "../controllers/v1/types";
import { getACUCTeam } from "../controllers/auth";
import { logger } from "./logger";

/**
 * Raster image OCR rides on FirePDF. Whether a team gets it is decided here
 * and nowhere else: the `imageOcr` team flag forces it on (`true`) or off
 * (`false`), and a team without the flag follows the deployment-wide
 * `IMAGE_OCR_ENABLED` default. Every entry point (URL-extension routing, the
 * browser handoff, parse uploads) consults this one check, so a team for
 * which it is off gets exactly the pre-existing unsupported-file behaviour.
 */
export function isImageOcrEnabled(
  teamFlags: TeamFlags | null | undefined,
): boolean {
  if (!config.FIRE_PDF_BASE_URL) return false;
  const flag = teamFlags?.imageOcr;
  if (flag === true) return true;
  if (flag === false) return false;
  return config.IMAGE_OCR_ENABLED;
}

/** Per-scrape gate: resolved lazily on first call and memoized. */
export type ImageOcrGate = () => Promise<boolean>;

const OFF: Promise<boolean> = Promise.resolve(false);

/**
 * Builds the per-scrape gate: whether this request may OCR raster images.
 *
 * Two conditions fold into it. The request's `parsers` must include the
 * `image` parser — it does by default, and a parse upload of an image counts
 * regardless — and image OCR must be on for the team (its `imageOcr` flag,
 * else the deployment default; see isImageOcrEnabled). A request that opted
 * out is settled up front without any I/O.
 *
 * For the team side, single scrapes and parse uploads carry the
 * authenticated team's flags in their internalOptions and resolve without
 * I/O; batch-scrape and crawl jobs do not, so for those the flags come from
 * the cached team ACUC. That lookup is deferred until a caller actually needs
 * the answer (an image-extension URL, an image handoff, the image engine, a
 * cached image document) and memoized, so the ordinary HTML documents that
 * make up almost every crawl never pay for it. A lookup failure leaves
 * image OCR off for that scrape: the team may have opted out, and the
 * deployment default must never override an opt-out it could not read.
 */
export function imageOcrGate(
  teamId: string | undefined,
  teamFlags: TeamFlags | null | undefined,
  requested: boolean,
): ImageOcrGate {
  if (!requested) return () => OFF;
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
  if (!teamId) return isImageOcrEnabled(null);
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
