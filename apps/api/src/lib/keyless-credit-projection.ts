import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { hasFormatOfType } from "./format-utils";

// Mirrors calculateCreditsToBeBilled's json surcharge: additive, so json stacks
// on lockdown (1 base + 4 lockdown + 4 json = 9) instead of replacing it at 5.
// The projection reserves credits before the scrape runs and reconciles against
// what the scrape billed, so a projection below the bill lets a keyless request
// overrun the IP's daily allowance.
const jsonCostBonus = 4;

export function projectScrapeCredits(
  options: ScrapeOptions,
  flags: TeamFlags,
  zeroDataRetention: boolean,
): number {
  let credits = 1;

  if (options.lockdown) {
    credits += 4;
  }

  const changeTrackingFormat = hasFormatOfType(
    options.formats,
    "changeTracking",
  );
  if (
    hasFormatOfType(options.formats, "json") ||
    changeTrackingFormat?.modes?.includes("json")
  ) {
    // Additive, as in calculateCreditsToBeBilled, so an earlier lockdown
    // surcharge survives.
    credits += jsonCostBonus;
  }

  if (hasFormatOfType(options.formats, "deterministicJson")) {
    credits = 10;
  }

  if (options.checkPromptInjection) {
    credits += 4;
  }

  if (
    hasFormatOfType(options.formats, "question") ||
    hasFormatOfType(options.formats, "query")
  ) {
    credits += 4;
  }

  if (hasFormatOfType(options.formats, "highlights")) {
    credits += 4;
  }

  if (hasFormatOfType(options.formats, "audio")) {
    credits += 4;
  }

  if (hasFormatOfType(options.formats, "video")) {
    credits += 4;
  }

  if (zeroDataRetention && !options.lockdown) {
    credits += flags?.zdrCost ?? 1;
  }

  if (options.redactPII) {
    credits += 4;
  }

  return credits;
}

function projectSearchCredits(
  limit: number,
  enterprise: ("default" | "anon" | "zdr")[] | undefined,
): number {
  const creditsPerTenResults = enterprise?.includes("zdr") ? 10 : 2;
  return Math.ceil(limit / 10) * creditsPerTenResults;
}

export function projectSearchTotalCredits(
  params: {
    limit: number;
    enterprise?: ("default" | "anon" | "zdr")[];
    scrapeOptions?: ScrapeOptions;
    freeSearch?: boolean;
  },
  flags: TeamFlags,
  zeroDataRetention: boolean,
): number {
  const searchCredits = params.freeSearch
    ? 0
    : projectSearchCredits(params.limit, params.enterprise);
  const shouldScrape =
    params.scrapeOptions?.formats && params.scrapeOptions.formats.length > 0;
  if (!shouldScrape || !params.scrapeOptions) return searchCredits;

  return (
    searchCredits +
    params.limit *
      projectScrapeCredits(params.scrapeOptions, flags, zeroDataRetention)
  );
}
