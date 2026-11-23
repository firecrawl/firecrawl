import { search } from "../../search";
import type { Logger } from "winston";
import { getEffectiveSearchForcedKind } from "../../lib/safe-mode";
import {
  DocumentWithCostTracking,
  scrapeSearchResults,
} from "../../search/scrape";
import { fromV1ScrapeOptions } from "../v2/types";
import { isUsOnly } from "../../lib/us-only";

// Used for deep research
export async function searchAndScrapeSearchResult(
  query: string,
  options: {
    teamId: string;
    orgId?: string | null;
    origin: string;
    timeout: number;
    scrapeOptions: any;
    apiKeyId: number | null;
    requestId?: string;
  },
  logger: Logger,
  flags: any,
): Promise<DocumentWithCostTracking[]> {
  try {
    const forcedKind = getEffectiveSearchForcedKind(flags, undefined);
    const searchResults = await search({
      query,
      logger,
      num_results: 5,
      usOnly: isUsOnly(flags),
      enterprise: forcedKind ? [forcedKind] : undefined,
    });

    const { scrapeOptions } = fromV1ScrapeOptions(
      options.scrapeOptions,
      options.timeout,
      options.teamId,
    );

    return await scrapeSearchResults(
      searchResults.map(r => ({
        url: r.url,
        title: r.title,
        description: r.description,
      })),
      {
        teamId: options.teamId,
        orgId: options.orgId ?? null,
        origin: options.origin,
        timeout: options.timeout,
        scrapeOptions,
        apiKeyId: options.apiKeyId,
        requestId: options.requestId,
      },
      logger,
      flags,
    );
  } catch (error) {
    return [];
  }
}
