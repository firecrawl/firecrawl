import type { ScrapeJobSingleUrls } from "../types";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { checkPermissions } from "./permissions";
import { UNSUPPORTED_SITE_MESSAGE } from "./strings";

type BlockContext = {
  team_id?: string | null;
  origin?: string | null;
};

type BlocklistCheck = (
  url: string,
  flags: any,
  context?: BlockContext,
) => boolean;

export function checkScrapeJobPermissions(
  jobData: ScrapeJobSingleUrls,
  flags: any,
  isBlocked: BlocklistCheck = isUrlBlocked,
): { error?: string } {
  if (
    isBlocked(jobData.url, flags, {
      team_id: jobData.team_id,
      origin: jobData.origin,
    })
  ) {
    return { error: UNSUPPORTED_SITE_MESSAGE };
  }

  return checkPermissions(jobData, flags);
}
