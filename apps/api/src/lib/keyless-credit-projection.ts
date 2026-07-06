import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { hasFormatOfType } from "./format-utils";
import { WEB_RISK_CREDITS_PER_SCANNED_URL } from "../search/web-risk";

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

  if (
    options.proxy === "stealth" ||
    options.proxy === "enhanced" ||
    options.proxy === "auto"
  ) {
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
    sources?: Array<{ type: string } | string>;
    enterprise?: ("default" | "anon" | "zdr")[];
    scrapeOptions?: ScrapeOptions;
    filterRiskyURLs?: boolean | { enabled?: boolean };
  },
  flags: TeamFlags,
  zeroDataRetention: boolean,
): number {
  const searchCredits = projectSearchCredits(params.limit, params.enterprise);
  const sourceCount = new Set(
    (params.sources ?? [{ type: "web" }]).map(s =>
      typeof s === "string" ? s : s.type,
    ),
  ).size;
  const riskFilterCredits =
    params.filterRiskyURLs &&
    (params.filterRiskyURLs === true ||
      params.filterRiskyURLs.enabled !== false)
      ? params.limit * sourceCount * WEB_RISK_CREDITS_PER_SCANNED_URL
      : 0;
  const shouldScrape =
    params.scrapeOptions?.formats && params.scrapeOptions.formats.length > 0;
  if (!shouldScrape || !params.scrapeOptions) {
    return searchCredits + riskFilterCredits;
  }

  return (
    searchCredits +
    riskFilterCredits +
    params.limit *
      projectScrapeCredits(params.scrapeOptions, flags, zeroDataRetention)
  );
}
