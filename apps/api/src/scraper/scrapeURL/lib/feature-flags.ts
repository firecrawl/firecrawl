import { ScrapeOptions } from "../../../controllers/v2/types";
import { hasFormatOfType } from "../../../lib/format-utils";
import { InternalOptions } from "./internal-options";

const featureFlags = [
  "actions",
  "waitFor",
  "screenshot",
  "screenshot@fullScreen",
  "audio",
  "video",
  "atsv",
  "location",
  "mobile",
  "branding",
  "disableAdblock",
] as const;

export type FeatureFlag = (typeof featureFlags)[number];

export function buildFeatureFlags(
  options: ScrapeOptions,
  internalOptions: InternalOptions,
): {
  flags: Set<FeatureFlag>;
  warnings: string[];
} {
  const flags: Set<FeatureFlag> = new Set();
  const warnings: string[] = [];

  // Lockdown forces index-only engines and ignores every request-time feature.
  // Return empty so the fallback threshold never filters index engines out.
  if (options.lockdown) {
    return {
      flags,
      warnings,
    };
  }

  if (options.actions !== undefined && options.actions.length > 0) {
    flags.add("actions");
  }

  if (hasFormatOfType(options.formats, "screenshot")) {
    if (hasFormatOfType(options.formats, "screenshot")?.fullPage) {
      flags.add("screenshot@fullScreen");
    } else {
      flags.add("screenshot");
    }
  }

  if (hasFormatOfType(options.formats, "branding")) {
    flags.add("branding");
  }

  if (hasFormatOfType(options.formats, "audio")) {
    flags.add("audio");
  }

  if (hasFormatOfType(options.formats, "video")) {
    flags.add("video");
  }

  if (options.waitFor !== 0) {
    flags.add("waitFor");
  }

  if (internalOptions.atsv) {
    flags.add("atsv");
  }

  if (options.location) {
    flags.add("location");
  }

  if (options.mobile) {
    flags.add("mobile");
  }

  if (options.fastMode) {
    warnings.push("The fastMode parameter is no longer supported.");
  }

  if (options.blockAds === false) {
    flags.add("disableAdblock");
  }

  return {
    flags,
    warnings,
  };
}
