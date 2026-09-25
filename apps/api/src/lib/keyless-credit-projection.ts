import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { hasFormatOfType } from "./format-utils";
import {
  resolveSearchCostPerTenResults,
  searchCreditsForResults,
} from "./search-credits";

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
    credits = 5;
  }

  if (hasFormatOfType(options.formats, "deterministicJson")) {
    credits = 10;
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
  flags: TeamFlags,
): number {
  // The projection quotes the requested limit, not the returned count.
  const costPerTenResults = resolveSearchCostPerTenResults(
    flags,
    !!enterprise?.includes("zdr"),
  );
  return searchCreditsForResults(limit, costPerTenResults);
}

export function projectSearchTotalCredits(
  params: {
    limit: number;
    enterprise?: ("default" | "anon" | "zdr")[];
    scrapeOptions?: ScrapeOptions;
  },
  flags: TeamFlags,
  zeroDataRetention: boolean,
): number {
  const searchCredits = projectSearchCredits(
    params.limit,
    params.enterprise,
    flags,
  );
  const shouldScrape =
    params.scrapeOptions?.formats && params.scrapeOptions.formats.length > 0;
  if (!shouldScrape || !params.scrapeOptions) return searchCredits;

  return (
    searchCredits +
    params.limit *
      projectScrapeCredits(params.scrapeOptions, flags, zeroDataRetention)
  );
}
