import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { Document, ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { CostTracking } from "../lib/cost-tracking";
import { resolveJobPriority } from "../lib/limits";
import { service } from "../service";
import { NuQJob } from "../services/worker/nuq";
import { processJobInternal } from "../services/worker/scrape-worker";
import { ScrapeJobData } from "../types";
import { SearchV2Response } from "../lib/entities";
import type { BillingMetadata } from "../lib/billing-types";
import {
  contextThreatProtection,
  requestContext,
} from "../lib/request-context";
import type { RequestContext } from "../service/request-context";

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
  orgId?: string | null;
  origin: string;
  timeout: number;
  scrapeOptions: ScrapeOptions;
  bypassBilling?: boolean;
  apiKeyId: number | null;
  zeroDataRetention?: boolean;
  requestId?: string;
  billing?: BillingMetadata;
  agentIndexOnly?: boolean;
  keylessReserved?: boolean;
  workContactOnly?: boolean;
  concurrencyLimit?: number;
  rateLimitMultiplier?: number;
  ctx?: RequestContext;
}

async function scrapeSearchResultDirect(
  searchResult: ScrapeJobInput,
  options: ScrapeSearchOptions,
  logger: Logger,
  flags: TeamFlags,
  ctx: RequestContext,
  jobPriority: number,
): Promise<DocumentWithCostTracking> {
  const jobId = uuidv7();
  const zeroDataRetention = ctx.zeroDataRetention;
  const threatProtection = contextThreatProtection(ctx);

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
        ctx,
        team_id: options.teamId,
        scrapeOptions: {
          ...options.scrapeOptions,
          maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
        } as ScrapeOptions,
        internalOptions: {
          ctx,
          teamId: options.teamId,
          orgId: options.orgId ?? null,
          bypassBilling: options.bypassBilling ?? true,
          zeroDataRetention: ctx.zeroDataRetention,
          teamFlags: flags,
          agentIndexOnly: options.agentIndexOnly ?? false,
          ...(options.workContactOnly ? { workContactOnly: true } : {}),
          // Rolling-deploy compatibility dual-write alongside the ctx fallback.
          ...(threatProtection !== undefined ? { threatProtection } : {}),
        },
        skipNuq: true,
        origin: options.origin,
        is_scrape: false,
        startTime: Date.now(),
        zeroDataRetention,
        apiKeyId: options.apiKeyId,
        keylessReserved: options.keylessReserved ?? false,
        requestId: options.requestId,
        billing: options.billing,
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

function hasForcedScrapeZdr(flags: TeamFlags | null | undefined): boolean {
  const raw = flags as Record<string, unknown> | null | undefined;
  return (
    raw?.scrapeZDR === "forced" ||
    raw?.forceZDR === true ||
    raw?.allowZDR === "forced"
  );
}

export function getItemsToScrape(
  searchResponse: SearchV2Response,
  flags: TeamFlags,
  context?: {
    team_id?: string | null;
    org_id?: string | null;
    origin?: string | null;
    zeroDataRetention?: boolean;
    safeMode?: boolean;
    ctx?: RequestContext;
  },
): ScrapeItem[] {
  const items: ScrapeItem[] = [];
  const forcedScrapeZdr = hasForcedScrapeZdr(context?.ctx?.flags ?? flags);
  const blockZeroDataRetention =
    (context?.ctx?.zeroDataRetention ?? false) ||
    context?.zeroDataRetention === true ||
    forcedScrapeZdr;
  const blockCtx = context?.ctx
    ? blockZeroDataRetention === context.ctx.zeroDataRetention
      ? context.ctx
      : { ...context.ctx, zeroDataRetention: blockZeroDataRetention }
    : requestContext({
        teamId: context?.team_id ?? "",
        zeroDataRetention: blockZeroDataRetention,
        flags,
        orgId: context?.org_id ?? null,
      });
  const blockOptions =
    context === undefined
      ? { record: false }
      : { origin: context.origin ?? null };

  if (searchResponse.web) {
    for (const item of searchResponse.web) {
      if (
        !service.modules.blocklist.isBlocked(item.url, blockCtx, blockOptions)
      ) {
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
      if (
        item.url &&
        !service.modules.blocklist.isBlocked(item.url, blockCtx, blockOptions)
      ) {
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
      if (
        item.url &&
        !service.modules.blocklist.isBlocked(item.url, blockCtx, blockOptions)
      ) {
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

  const parentCtx =
    options.ctx ??
    requestContext({
      teamId: options.teamId,
      zeroDataRetention: options.zeroDataRetention ?? false,
      flags,
      orgId: options.orgId ?? null,
      apiKeyId: options.apiKeyId,
      billing: options.billing,
      concurrencyLimit: options.concurrencyLimit,
      rateLimitMultiplier: options.rateLimitMultiplier,
    });
  const childZeroDataRetention =
    parentCtx.zeroDataRetention ||
    Boolean(options.zeroDataRetention) ||
    hasForcedScrapeZdr(parentCtx.flags ?? flags);
  const childCtx: RequestContext =
    childZeroDataRetention === parentCtx.zeroDataRetention
      ? parentCtx
      : { ...parentCtx, zeroDataRetention: childZeroDataRetention };

  const jobPriority = await resolveJobPriority(childCtx, 10, error => {
    logger.error("Failed to determine job priority", { error });
  });

  logger.info(`Starting ${items.length} concurrent scrapes for search results`);

  const results = await Promise.all(
    items.map(item =>
      scrapeSearchResultDirect(
        item,
        options,
        logger,
        flags,
        childCtx,
        jobPriority,
      ),
    ),
  );

  logger.info(
    `Completed ${results.length} concurrent scrapes for search results`,
  );

  return results;
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
