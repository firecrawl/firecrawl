import { ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { hasFormatOfType } from "./format-utils";

export function projectScrapeCredits(
  options: ScrapeOptions,
  flags: TeamFlags,
  zeroDataRetention: boolean,
): number {
  let credits = 1;

  const lockdown = (options as { lockdown?: boolean }).lockdown === true;
  if (lockdown) {
    credits += 4;
  }

  const rawFormats = (options.formats ?? []) as Array<{
    type: string;
    modes?: string[];
  }>;
  const changeTrackingFormat = rawFormats.find(
    f => f.type === "changeTracking",
  );
  if (
    hasFormatOfType(options.formats, "json") ||
    changeTrackingFormat?.modes?.includes("json")
  ) {
    credits = 5;
  }

  if (rawFormats.some(f => f.type === "deterministicJson")) {
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

  if (rawFormats.some(f => f.type === "highlights")) {
    credits += 4;
  }

  if (rawFormats.some(f => f.type === "audio")) {
    credits += 4;
  }

  if (rawFormats.some(f => f.type === "video")) {
    credits += 4;
  }

  if (zeroDataRetention && !lockdown) {
    credits += flags?.zdrCost ?? 1;
  }

  if ((options as Record<string, unknown>).redactPII) {
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
