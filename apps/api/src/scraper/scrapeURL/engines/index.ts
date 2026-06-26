import { config } from "../../../config";
import { getPDFMaxPages } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { useIndex } from "../../../services";
import { Meta } from "../lib/meta";
import { fetchEngine } from "./fetch";
import { fireEngine } from "./fire-engine";
import { playwrightEngine } from "./playwright";
import type { Engine, SpecialEngine } from "./types";
import { wikipediaSpecialEngine } from "./wikipedia";
import { xTwitterSpecialEngine } from "./x-twitter";

const useFireEngine =
  config.FIRE_ENGINE_BETA_URL !== "" &&
  config.FIRE_ENGINE_BETA_URL !== undefined;
const usePlaywright =
  config.PLAYWRIGHT_MICROSERVICE_URL !== "" &&
  config.PLAYWRIGHT_MICROSERVICE_URL !== undefined;
const useWikipedia =
  config.WIKIPEDIA_ENTERPRISE_USERNAME !== undefined &&
  config.WIKIPEDIA_ENTERPRISE_USERNAME !== "" &&
  config.WIKIPEDIA_ENTERPRISE_PASSWORD !== undefined &&
  config.WIKIPEDIA_ENTERPRISE_PASSWORD !== "";
const useXTwitter =
  (config.XAI_API_KEY !== undefined && config.XAI_API_KEY !== "") ||
  config.USE_DB_AUTHENTICATION === true;

const specialEngines: SpecialEngine[] = [
  ...(useWikipedia ? [wikipediaSpecialEngine] : []),
  ...(useXTwitter ? [xTwitterSpecialEngine] : []),
];

export function shouldUseIndex(meta: Meta) {
  if (meta.internalOptions.isParse) {
    return false;
  }

  // Skip index if screenshot format has custom viewport or quality settings
  const screenshotFormat = hasFormatOfType(meta.options.formats, "screenshot");
  const hasCustomScreenshotSettings =
    screenshotFormat?.viewport !== undefined ||
    screenshotFormat?.quality !== undefined;

  return (
    useIndex &&
    config.FIRECRAWL_INDEX_WRITE_ONLY !== true &&
    !hasFormatOfType(meta.options.formats, "changeTracking") &&
    !hasFormatOfType(meta.options.formats, "branding") &&
    // Skip index if a non-default PDF maxPages is specified
    getPDFMaxPages(meta.options.parsers) === undefined &&
    !hasCustomScreenshotSettings &&
    meta.options.maxAge !== 0 &&
    (meta.options.headers === undefined ||
      Object.keys(meta.options.headers).length === 0) &&
    (meta.options.actions === undefined || meta.options.actions.length === 0) &&
    meta.options.profile === undefined
  );
}

export const mainEngine: Engine = useFireEngine
  ? fireEngine
  : usePlaywright
    ? playwrightEngine
    : fetchEngine;

export function resolveSpecialEngineFromURL(url: string): SpecialEngine | null {
  return specialEngines.find(x => x.special.matches(url)) ?? null;
}

export type { FeatureFlag } from "../lib/feature-flags";
