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
import type { BillingMetadata } from "../services/billing/types";
import { getScrapeZDR } from "../lib/zdr-helpers";
import type { ThreatProtectionPolicy } from "../lib/threat-protection/types";

export interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

interface ScrapeJobInput {
  url: string;
  title: string;
  description: string;
}

export interface ScrapeItem {
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
  threatProtectionPolicy?: ThreatProtectionPolicy | null;
  safeModeBypassed?: boolean;
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
    getScrapeZDR(flags) === "forced" || (options.zeroDataRetention ?? false);

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
          orgId: options.orgId ?? null,
          bypassBilling: options.bypassBilling ?? true,
          zeroDataRetention,
          teamFlags: flags,
          agentIndexOnly: options.agentIndexOnly ?? false,
          threatProtection: options.threatProtectionPolicy ?? undefined,
          safeModeBypassed: options.safeModeBypassed === true,
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

export function getItemsToScrape(
  searchResponse: SearchV2Response,
  flags: TeamFlags,
  context?: {
    team_id?: string | null;
    org_id?: string | null;
    origin?: string | null;
  },
): ScrapeItem[] {
  const items: ScrapeItem[] = [];

  if (searchResponse.web) {
    for (const item of searchResponse.web) {
      if (!isUrlBlocked(item.url, flags, context)) {
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
      if (item.url && !isUrlBlocked(item.url, flags, context)) {
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
      if (item.url && !isUrlBlocked(item.url, flags, context)) {
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

/**
 * Whether a search scrape can be served from the page text the search
 * backend already returned (`rawContent`) instead of a real scrape job.
 *
 * The backend text is a plain main-content extraction: no JavaScript was
 * executed and no Firecrawl conversion ran. It can therefore only stand in
 * for a markdown-only request that carries no scrape behaviour of its own —
 * anything that needs the live page (actions, waiting, parsers, a browser
 * profile, custom headers, tag filters, PII redaction, prompt-injection
 * scanning, lockdown, …) must go through the real scrape pipeline. Because
 * the text is main-content extraction, it also cannot satisfy a request
 * that explicitly asked for the full page (`onlyMainContent: false`) or
 * for page furniture an extraction strips (ads kept via
 * `blockAds: false`, base64 images kept via
 * `removeBase64Images: false`).
 *
 * The same applies to requests that constrain the content itself rather
 * than the scrape mechanics: a location (the backend fetched from its own
 * egress, in its own locale), a freshness bound (`maxAge` / `minAge` —
 * the text's fetch time is the backend's, unverifiable here, and the
 * pipeline's cache/index engines are what honour those bounds), a
 * stealth/enhanced proxy (a different egress class that can see different
 * content), the `onlyCleanContent` LLM cleaning pass, fast mode's engine
 * selection, or a mock response. Options that change none of the produced
 * content — the scrape `timeout` budget, `skipTlsVerification` (fetch
 * success only; text exists only when a fetch already succeeded),
 * `storeInCache` (a cache side effect; this path writes nothing) — do not
 * disqualify.
 *
 * Blocklist note: result URLs reach the fast path only via
 * `getItemsToScrape`, which drops `isUrlBlocked` matches, and execute.ts
 * re-checks the URL before serving. The scrape worker additionally
 * re-checks the post-redirect final URL; the fast path cannot — the
 * backend returns page text, not the final URL it fetched — so a result
 * whose backend fetch was redirected onto a blocked host is a known
 * residual gap of this path.
 */
export function canServeFromRawContent(scrapeOptions: ScrapeOptions): boolean {
  const formats = scrapeOptions.formats ?? [];
  if (formats.length === 0) {
    return false;
  }
  const types = formats.map((f: any) => (typeof f === "string" ? f : f.type));
  if (!types.every(type => type === "markdown")) {
    return false;
  }
  if (scrapeOptions.onlyMainContent === false) {
    return false;
  }
  if (scrapeOptions.actions && scrapeOptions.actions.length > 0) {
    return false;
  }
  if ((scrapeOptions.waitFor ?? 0) > 0) {
    return false;
  }
  if (scrapeOptions.parsers && scrapeOptions.parsers.length > 0) {
    return false;
  }
  if (scrapeOptions.profile) {
    return false;
  }
  if (scrapeOptions.mobile) {
    return false;
  }
  if (scrapeOptions.lockdown) {
    return false;
  }
  if (scrapeOptions.headers && Object.keys(scrapeOptions.headers).length > 0) {
    return false;
  }
  if (scrapeOptions.includeTags?.length || scrapeOptions.excludeTags?.length) {
    return false;
  }
  if (scrapeOptions.checkPromptInjection) {
    return false;
  }
  if (scrapeOptions.redactPII !== undefined) {
    return false;
  }
  // A location asks for content as seen from that country / in those
  // languages; the backend text was fetched from the backend's own egress.
  // (`country: "us-generic"` is the schema's implicit default for an
  // otherwise empty location object and carries no localization intent.)
  const location = scrapeOptions.location;
  if (
    location &&
    ((location.languages?.length ?? 0) > 0 ||
      (location.country !== undefined && location.country !== "us-generic"))
  ) {
    return false;
  }
  // Freshness bounds are honoured by the pipeline's cache/index engines
  // against Firecrawl-side fetch times; the backend text's age is unknown.
  if (scrapeOptions.maxAge !== undefined) {
    return false;
  }
  if (scrapeOptions.minAge !== undefined) {
    return false;
  }
  if (scrapeOptions.onlyCleanContent) {
    return false;
  }
  if (scrapeOptions.fastMode) {
    return false;
  }
  if (scrapeOptions.proxy === "stealth" || scrapeOptions.proxy === "enhanced") {
    return false;
  }
  if (scrapeOptions.useMock !== undefined) {
    return false;
  }
  if (scrapeOptions.blockAds === false) {
    return false;
  }
  if (scrapeOptions.removeBase64Images === false) {
    return false;
  }
  if (scrapeOptions.__experimental_omce) {
    return false;
  }
  if (scrapeOptions.__experimental_engpicker) {
    return false;
  }
  return true;
}

/**
 * Build the document for a search result from the backend-provided page
 * text, or `null` when the result carries none (results beyond the
 * backend's top-N, non-web results, fetch failures upstream).
 *
 * The text is plain extracted text, not Markdown produced by Firecrawl's
 * converter — headings, links and images are already flattened upstream.
 * It is placed in the `markdown` field because that is the field a
 * markdown-only request consumes; callers must gate on
 * {@link canServeFromRawContent} so nothing else is promised.
 */
export function rawContentDocument(
  item: ScrapeItem,
): DocumentWithCostTracking | null {
  const rawContent: unknown = item.item?.rawContent;
  if (typeof rawContent !== "string" || rawContent.trim().length === 0) {
    return null;
  }

  const document: Document = {
    title: item.scrapeInput.title,
    description: item.scrapeInput.description,
    url: item.scrapeInput.url,
    markdown: rawContent,
    metadata: {
      statusCode: 200,
      proxyUsed: "basic",
      sourceURL: item.scrapeInput.url,
    },
  };

  return {
    document,
    costTracking: new CostTracking().toJSON(),
  };
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
