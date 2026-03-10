import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { Document, ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { CostTracking } from "../lib/cost-tracking";
import { getJobPriority } from "../lib/job-priority";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { NuQJob } from "../services/worker/nuq";
import { processJobInternal } from "../services/worker/scrape-worker";
import { ScrapeJobData } from "../types";
import { SearchV2Response } from "../lib/entities";

export interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

interface ScrapeJobInput {
  url: string;
  title: string;
  description: string;
}

interface ScrapeItem {
  item: any;
  type: "web" | "news" | "image";
  scrapeInput: ScrapeJobInput;
}

interface ScrapeSearchOptions {
  teamId: string;
  origin: string;
  timeout: number;
  scrapeOptions: ScrapeOptions;
  bypassBilling?: boolean;
  apiKeyId: number | null;
  zeroDataRetention?: boolean;
  requestId?: string;
}

async function scrapeSearchResultDirect(
  searchResult: ScrapeJobInput,
  options: ScrapeSearchOptions,
  logger: Logger,
  flags: TeamFlags,
  jobPriority: number,
): Promise<DocumentWithCostTracking> {
  const jobId = uuidv7();
  const zeroDataRetention =
    flags?.forceZDR || (options.zeroDataRetention ?? false);

  logger.debug("Starting direct scrape for search result", {
    scrapeId: jobId,
    url: searchResult.url,
    teamId: options.teamId,
    origin: options.origin,
    zeroDataRetention,
  });

  try {
    const job: NuQJob<ScrapeJobData> = {
      id: jobId,
      status: "active",
      createdAt: new Date(),
      priority: jobPriority,
      data: {
        url: searchResult.url,
        mode: "single_urls",
        team_id: options.teamId,
        scrapeOptions: {
          ...options.scrapeOptions,
          maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
        },
        internalOptions: {
          teamId: options.teamId,
          bypassBilling: options.bypassBilling ?? true,
          zeroDataRetention,
          teamFlags: flags,
        },
        skipNuq: true,
        origin: options.origin,
        is_scrape: false,
        startTime: Date.now(),
        zeroDataRetention,
        apiKeyId: options.apiKeyId,
        requestId: options.requestId,
      },
    };

    const doc = await processJobInternal(job);

    logger.debug("Direct scrape completed for search result", {
      scrapeId: jobId,
      url: searchResult.url,
    });

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      ...doc,
      metadata: doc?.metadata ?? {
        statusCode: 200,
        proxyUsed: "basic",
      },
    };

    return {
      document,
      costTracking: new CostTracking().toJSON(),
    };
  } catch (error) {
    logger.error(`Error in scrapeSearchResultDirect: ${error}`, {
      url: searchResult.url,
      teamId: options.teamId,
      scrapeId: jobId,
    });

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      metadata: {
        statusCode: 500,
        error: error.message,
        proxyUsed: "basic",
      },
    };

    return {
      document,
      costTracking: new CostTracking().toJSON(),
    };
  }
}

export function getItemsToScrape(
  searchResponse: SearchV2Response,
  flags: TeamFlags,
): ScrapeItem[] {
  const items: ScrapeItem[] = [];

  if (searchResponse.web) {
    for (const item of searchResponse.web) {
      if (!isUrlBlocked(item.url, flags)) {
        items.push({
          item,
          type: "web",
          scrapeInput: {
            url: item.url,
            title: item.title,
            description: item.description,
          },
        });
      }
    }
  }

  if (searchResponse.news) {
    for (const item of searchResponse.news) {
      if (item.url && !isUrlBlocked(item.url, flags)) {
        items.push({
          item,
          type: "news",
          scrapeInput: {
            url: item.url,
            title: item.title || "",
            description: item.snippet || "",
          },
        });
      }
    }
  }

  if (searchResponse.images) {
    for (const item of searchResponse.images) {
      if (item.url && !isUrlBlocked(item.url, flags)) {
        items.push({
          item,
          type: "image",
          scrapeInput: {
            url: item.url,
            title: item.title || "",
            description: "",
          },
        });
      }
    }
  }

  return items;
}

export async function scrapeSearchResults(
  items: ScrapeJobInput[],
  options: ScrapeSearchOptions,
  logger: Logger,
  flags: TeamFlags,
): Promise<DocumentWithCostTracking[]> {
  if (items.length === 0) {
    return [];
  }

  const jobPriority = await getJobPriority({
    team_id: options.teamId,
    basePriority: 10,
  });

  logger.info(`Starting ${items.length} concurrent scrapes for search results`);

  const results = await Promise.all(
    items.map(item =>
      scrapeSearchResultDirect(item, options, logger, flags, jobPriority),
    ),
  );

  logger.info(
    `Completed ${results.length} concurrent scrapes for search results`,
  );

  return results;
}

export function calculateScrapeCredits(
  docs: DocumentWithCostTracking[],
): number {
  return docs.reduce(
    (total, { document }) => total + (document.metadata?.creditsUsed ?? 0),
    0,
  );
}

export function mergeScrapedContent(
  searchResponse: SearchV2Response,
  items: ScrapeItem[],
  docs: DocumentWithCostTracking[],
): void {
  const resultsMap = new Map<string, Document>();
  items.forEach((item, index) => {
    resultsMap.set(item.scrapeInput.url, docs[index].document);
  });

  if (searchResponse.web?.length) {
    searchResponse.web = searchResponse.web.map(item => ({
      ...item,
      ...resultsMap.get(item.url),
    }));
  }
  if (searchResponse.news?.length) {
    searchResponse.news = searchResponse.news.map(item => ({
      ...item,
      ...(item.url ? resultsMap.get(item.url) : {}),
    }));
  }
  if (searchResponse.images?.length) {
    searchResponse.images = searchResponse.images.map(item => ({
      ...item,
      ...(item.url ? resultsMap.get(item.url) : {}),
    }));
  }
}
