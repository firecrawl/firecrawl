import { configDotenv } from "dotenv";
import { config } from "../../config";
import http from "node:http";
import https from "node:https";

import { logger as _logger } from "../../lib/logger";
import { safeParseLogged } from "../../lib/zod-log";
import {
  concurrentJobDone,
  pushConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { cacheableLookup } from "../../scraper/scrapeURL/lib/cacheableLookup";
import { v7 as uuidv7 } from "uuid";
import type { StoredCrawl } from "../../lib/crawl-redis";
import {
  addCrawlJob,
  addCrawlJobs,
  addCrawlJobDone,
  crawlToCrawler,
  queueCrawlJobDoneRepair,
  recordRobotsBlocked,
  finishCrawlKickoff,
  generateURLPermutations,
  getCrawl,
  lockURL,
  lockURLsIndividually,
  normalizeURL,
  saveCrawl,
  setCrawlError,
} from "../../lib/crawl-redis";
import { redisEvictConnection } from "../redis";
import { crawlStateStore } from "../../lib/crawl-state-store";
import {
  _addScrapeJobToBullMQ,
  addScrapeJob,
  addScrapeJobs,
} from "../queue-jobs";
import { parseHostname } from "../../lib/url-utils";
import {
  detectSerpPage,
  serpScrapeWarning,
  serpScrapeWarningEnabled,
} from "../../lib/serp-url";
import { resolveJobPriority } from "../../lib/limits";
import type { Document } from "../../controllers/v2/types";
import { getV2RequestSchemas } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import { startWebScraperPipeline } from "../../main/runWebScraper";
import { crawlContext, jobContext } from "../../lib/request-context";
import type {} from "../../lib/billing-state";
import { service } from "../../service";
import type { RequestContext } from "../../service";
import { installedService } from "../../service/service";
import { CostTracking } from "../../lib/cost-tracking";
import { normalizeUrlOnlyHostname } from "../../lib/canonical-url";

import type { WebCrawler } from "../../scraper/WebScraper/crawler";
import { DenialReason } from "../../scraper/WebScraper/crawler";
import { getCrawlScope } from "../../lib/crawl-scope";
import type { Logger } from "winston";
import {
  CrawlDenialError,
  JobCancelledError,
  RacedRedirectError,
  ScrapeJobTimeoutError,
  SitemapError,
  UnsupportedSiteError,
} from "../../lib/error";
import { serializeThrownError } from "../../lib/error-serde";
import type { NuQJob } from "./nuq";
import type {
  JobCrawlerOptions,
  ScrapeJobData,
  ScrapeJobKickoff,
  ScrapeJobKickoffSitemap,
  ScrapeJobSingleUrls,
} from "../../types";
import { z } from "zod";
import type { JsonObject } from "../../lib/json-types";
import { scrapeSitemap } from "../../scraper/crawler/sitemap";
import {
  withTraceContextAsync,
  withSpan,
  withZeroDataRetention,
  setSpanAttributes,
} from "../../lib/otel-tracer";
import type { ScrapeUrlResponse } from "../../scraper/scrapeURL";
import type { FeatureFlag } from "../../scraper/scrapeURL/engines";
import { createScrapeFinishedEmitter } from "../../scraper/scrapeURL/hooks";
import type { ScrapeFinishedOutcome } from "../../scraper/scrapeURL/hooks";
import type { JobKind } from "../../service/hooks";
import { summarizeWebhookForLog } from "../webhook/log";

configDotenv();

const jobLockExtendInterval = config.JOB_LOCK_EXTEND_INTERVAL;

if (require.main === module) {
  cacheableLookup.install(http.globalAgent);
  cacheableLookup.install(https.globalAgent);
}

type StoredCrawlerOptions = JobCrawlerOptions & {
  sitemapOnly?: boolean;
  ignoreSitemap?: boolean;
  maxDepth?: number;
};

const storedCrawlerShapeSchema = z.looseObject({});

const storedCrawlerObjectSchema = z.custom<StoredCrawlerOptions>(
  value =>
    safeParseLogged(
      storedCrawlerShapeSchema,
      value,
      "scrape-worker.crawlerOptions",
    ).success,
);

function parseLegacyNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseLegacyBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

const errorWithMessageSchema = z.object({
  message: z.string(),
});

function getStoredCrawlerOptions(sc: StoredCrawl): StoredCrawlerOptions | null {
  if (sc.crawlerOptions === null || sc.crawlerOptions === undefined) {
    return null;
  }
  const parsedObj = storedCrawlerObjectSchema.safeParse(sc.crawlerOptions);
  if (!parsedObj.success) {
    return null;
  }
  const normalized: StoredCrawlerOptions = { ...parsedObj.data };
  const rawLimit: unknown = parsedObj.data.limit;
  if (rawLimit !== undefined) {
    normalized.limit = parseLegacyNumber(rawLimit);
  }
  const rawMaxDepth: unknown = parsedObj.data.maxDepth;
  if (rawMaxDepth !== undefined) {
    normalized.maxDepth = parseLegacyNumber(rawMaxDepth);
  }
  const rawSitemapOnly: unknown = parsedObj.data.sitemapOnly;
  if (rawSitemapOnly !== undefined) {
    normalized.sitemapOnly = parseLegacyBoolean(rawSitemapOnly);
  }
  const rawIgnoreSitemap: unknown = parsedObj.data.ignoreSitemap;
  if (rawIgnoreSitemap !== undefined) {
    normalized.ignoreSitemap = parseLegacyBoolean(rawIgnoreSitemap);
  }
  return normalized;
}

function enrichContextWithTeam(
  ctx: RequestContext,
  team: Partial<RequestContext> | null | undefined,
): RequestContext {
  const enriched: RequestContext = { ...ctx };
  if (ctx.flags === undefined && team) {
    enriched.flags = team.flags ?? null;
  }
  if (
    ctx.concurrencyLimit === undefined &&
    team?.concurrencyLimit !== undefined
  ) {
    enriched.concurrencyLimit = team.concurrencyLimit;
  }
  if (
    ctx.rateLimitMultiplier === undefined &&
    team?.rateLimitMultiplier !== undefined
  ) {
    enriched.rateLimitMultiplier = team.rateLimitMultiplier;
  }
  return enriched;
}

type CrawlLinksHookInfo = {
  id: string;
  ctx: RequestContext;
  from: string;
  crawlerOptions?: JobCrawlerOptions | null;
  bypassBilling?: boolean;
};

type ProcessJobResult =
  | {
      success: true;
      result: {
        links: Array<{ content: Document; source: string; id: string }>;
      };
      document: Document;
    }
  | {
      success: false;
      document: null;
      error: Error;
    };

type KickoffJobResult = { success: true } | { success: false; error: unknown };

async function applyCrawlLinksHook(
  links: Array<string>,
  {
    crawlId,
    ctx,
    from,
    crawler,
    limit,
    maxDepth,
    fromMap = false,
    crawlerOptions,
    bypassBilling,
  }: {
    crawlId: string;
    ctx: RequestContext;
    from: string;
    crawler: WebCrawler;
    limit: number;
    maxDepth: number;
    fromMap?: boolean;
    crawlerOptions?: JobCrawlerOptions | null;
    bypassBilling?: boolean;
  },
): Promise<Array<string>> {
  const hooks = installedService()?.hooks;
  if (!hooks?.has("crawl.links") || links.length === 0) {
    return links;
  }
  const existing = new Set(links);
  const hookInfo: CrawlLinksHookInfo = {
    id: crawlId,
    ctx,
    from,
  };
  if (crawlerOptions !== undefined) {
    hookInfo.crawlerOptions = crawlerOptions;
  }
  if (bypassBilling !== undefined) {
    hookInfo.bypassBilling = bypassBilling;
  }
  const transformed = await hooks.transform("crawl.links", links, hookInfo);
  if (transformed.every(url => existing.has(url))) {
    return transformed;
  }
  const revalidated = await crawler.filterLinks(
    transformed,
    limit,
    maxDepth,
    fromMap,
  );
  await recordRobotsBlocked(crawlId, revalidated.robotsBlocked);
  return revalidated.links;
}

async function billScrapeJob(
  job: NuQJob<ScrapeJobSingleUrls>,
  document: Document | null,
  costTracking: CostTracking,
  error?: Error | null,
  unsupportedFeatures?: Set<FeatureFlag>,
  exchange?: JsonObject,
  threatDecisions?: Array<unknown>,
): Promise<number | undefined> {
  if (job.data.is_scrape === true || job.data.internalOptions?.bypassBilling) {
    return undefined;
  }

  const ctx = jobContext(job.data);
  return service.modules.billing.charge({
    kind: "scrape",
    ctx,
    jobId: job.id,
    requestId: job.data.requestId ?? job.data.crawl_id,
    options: job.data.scrapeOptions,
    document,
    costTracking,
    state: {
      internalOptions: job.data.internalOptions,
      crawlId: job.data.crawl_id,
      crawlerOptions: job.data.crawlerOptions,
      keylessReserved: job.data.keylessReserved,
      error: error ?? null,
      unsupportedFeatures,
      exchange,
      threatDecisions,
    },
  });
}

async function processJob(
  job: NuQJob<ScrapeJobSingleUrls>,
): Promise<ProcessJobResult> {
  const ctx = jobContext(job.data);
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
    zeroDataRetention: ctx.zeroDataRetention,
  });
  logger.info(`🐂 Worker taking job ${job.id}`, { url: job.data.url });
  const start = job.data.startTime ?? Date.now();
  const remainingTime = job.data.scrapeOptions.timeout
    ? job.data.scrapeOptions.timeout - (Date.now() - start)
    : undefined;

  const costTracking = new CostTracking();

  const abortController = new AbortController();
  const abortTimeoutHandle =
    remainingTime !== undefined
      ? setTimeout(
          () => abortController.abort(new ScrapeJobTimeoutError()),
          remainingTime,
        )
      : undefined;
  const signal = abortController.signal;

  // Hoisted above the try so the catch path can read pipeline.threatDecisions
  // for billing/logging even when the scrape failed.
  let pipeline: ScrapeUrlResponse | null = null;
  const scrapeKind: JobKind = job.data.crawl_id
    ? job.data.crawlerOptions !== null
      ? "crawl"
      : "batchScrape"
    : "scrape";
  const emitScrapeFinished = createScrapeFinishedEmitter({
    jobId: job.id,
    requestId: job.data.requestId ?? job.data.crawl_id ?? job.id,
    kind: scrapeKind,
    ctx,
    url: job.data.url,
    options: job.data.scrapeOptions,
    origin: job.data.origin,
    crawlId: job.data.crawl_id,
    skipNuq: job.data.skipNuq ?? false,
    isParse: Boolean(job.data.internalOptions?.isParse),
    getState: () => pipeline?.state,
  });
  let finishedOutcome: ScrapeFinishedOutcome | null = null;
  let resultData: ProcessJobResult | undefined;
  let failureCleanupError: unknown;
  let hasFailureCleanupError = false;
  let successBilled = false;
  let successBilledCredits: number | undefined;

  try {
    if (remainingTime !== undefined && remainingTime < 0) {
      throw new ScrapeJobTimeoutError();
    }

    if (job.data.crawl_id) {
      const sc = await getCrawl(job.data.crawl_id);
      if (
        !sc &&
        job.data.crawlerOptions !== null &&
        job.data.crawlerOptions !== undefined
      ) {
        throw new Error("Crawl not found");
      }
      if (sc && sc.cancelled) {
        throw new JobCancelledError();
      }

      // Discovered, sitemap and index URLs pass filterLinks before they are
      // queued. The start URL is not, so check it here, before it is fetched.
      if (
        sc &&
        job.data.isCrawlSourceScrape &&
        !crawlToCrawler(
          job.data.crawl_id,
          sc,
          (
            await installedService()?.modules.auth.lookupTeam?.(
              job.data.team_id,
            )
          )?.flags ??
            ctx.flags ??
            null,
        ).isRobotsAllowed(job.data.url)
      ) {
        throw new CrawlDenialError(DenialReason.ROBOTS_TXT, {
          robotsBlockedUrl: job.data.url,
        });
      }
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      pipeline = await Promise.race([
        startWebScraperPipeline({
          job,
          costTracking,
        }),
        ...(remainingTime !== undefined
          ? [
              (async () => {
                await new Promise(resolve => {
                  timeoutHandle = setTimeout(resolve, remainingTime);
                });

                throw new ScrapeJobTimeoutError();
              })(),
            ]
          : []),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    try {
      signal?.throwIfAborted();
    } catch {
      throw new ScrapeJobTimeoutError();
    }

    if (!pipeline.success) {
      throw pipeline.error;
    }

    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    const doc = pipeline.document;

    if (
      pipeline.exchange === undefined &&
      ctx.billing?.endpoint !== "monitor" &&
      !job.data.internalOptions?.isParse &&
      doc.metadata.url !== undefined &&
      doc.metadata.sourceURL !== undefined &&
      doc.metadata.url !== doc.metadata.sourceURL &&
      service.modules.blocklist.isBlocked(doc.metadata.url, ctx, {
        origin: job.data.origin ?? null,
      })
    ) {
      throw new UnsupportedSiteError();
    }

    const rawHtml = doc.rawHtml ?? "";

    if (!hasFormatOfType(job.data.scrapeOptions.formats, "rawHtml")) {
      delete doc.rawHtml;
    }

    if (job.data.concurrencyLimited) {
      doc.warning =
        "This scrape job was throttled at your current concurrency limit. If you'd like to scrape faster, you can upgrade your plan." +
        (doc.warning ? " " + doc.warning : "");
    }

    if (
      ctx.billing?.endpoint === "scrape" &&
      (job.data.scrapeOptions.actions?.length ?? 0) > 0
    ) {
      doc.warning =
        "You're using the actions parameter. For a more reliable and flexible experience, try the /interact endpoint instead." +
        (doc.warning ? " " + doc.warning : "");
    }

    const billingEndpoint = ctx.billing?.endpoint;
    if (billingEndpoint === "scrape" || billingEndpoint === "batch_scrape") {
      const serpPage = detectSerpPage(job.data.url);
      if (serpPage !== null) {
        // Logged whether or not the warning is shown, so the rollout can be
        // compared with teams outside it.
        const warned = serpScrapeWarningEnabled(job.data.team_id);
        logger.info("SERP scrape", {
          serpEngine: serpPage.engine,
          serpWarningShown: warned,
          billingEndpoint,
        });
        if (warned) {
          doc.warning =
            serpScrapeWarning(serpPage.engine) +
            (doc.warning ? " " + doc.warning : "");
        }
      }
    }

    const data: ProcessJobResult = {
      success: true,
      result: {
        links: [
          {
            content: doc,
            source: doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? "",
            id: job.id,
          },
        ],
      },
      document: doc,
    };

    // Ensure the parent `requests` row is committed before any child
    // `scrapes`/`parses` insert, to avoid a request_id FK violation. Runs on
    // both the crawl and single-scrape paths; only single scrapes actually
    // carry a logRequestPromise.
    if (job.data.logRequestPromise) {
      const start = Date.now();
      await job.data.logRequestPromise;
      const waited = Date.now() - start;
      if (waited > 0) {
        logger.warn("Had to wait for log request promise to complete", {
          timeMs: waited,
        });
      }
    }

    if (job.data.crawl_id) {
      const sc = await getCrawl(job.data.crawl_id);

      let crawler: WebCrawler | null = null;
      if (
        job.data.crawlerOptions !== null &&
        job.data.crawlerOptions !== undefined
      ) {
        if (!sc) {
          throw new Error("Crawl not found");
        }
        const teamFlags =
          (
            await installedService()?.modules.auth.lookupTeam?.(
              job.data.team_id,
            )
          )?.flags ??
          ctx.flags ??
          null;
        crawler = crawlToCrawler(
          job.data.crawl_id,
          sc,
          teamFlags,
          sc.originUrl,
          job.data.crawlerOptions,
        );
      }

      if (
        sc &&
        crawler && // only on crawls, don't care on batch scrape
        doc.metadata.url !== undefined &&
        doc.metadata.sourceURL !== undefined &&
        normalizeURL(doc.metadata.url, sc) !==
          normalizeURL(doc.metadata.sourceURL, sc)
      ) {
        // The engine has already followed the redirect, so this can only
        // keep a disallowed target out of the crawl.
        if (!crawler.isRobotsAllowed(doc.metadata.url)) {
          throw new CrawlDenialError(DenialReason.ROBOTS_TXT, {
            robotsBlockedUrl: doc.metadata.url,
          });
        }

        const filterResult = await crawler.filterURL(
          doc.metadata.url,
          doc.metadata.sourceURL,
        );
        if (!filterResult.allowed && !job.data.isCrawlSourceScrape) {
          const reason =
            filterResult.denialReason ||
            `The URL you requested redirected to a different URL ("${doc.metadata.url}"), but that redirected URL is not allowed by your crawl configuration (includePaths, excludePaths, allowBackwardCrawling, or other filters). The original URL was "${doc.metadata.sourceURL}". To include this redirected URL, adjust your crawl options to allow it.`;
          throw new CrawlDenialError(reason);
        }

        // Only re-set originUrl if it's different from the current hostname
        // This is only done on this condition to handle cross-domain redirects
        // If this would be done for non-crossdomain redirects, but also for e.g.
        // redirecting / -> /introduction (like our docs site does), it would
        // break crawling the entire site without allowBackwardsCrawling - mogery
        const isHostnameDifferent =
          normalizeUrlOnlyHostname(doc.metadata.url) !==
          normalizeUrlOnlyHostname(doc.metadata.sourceURL);
        if (job.data.isCrawlSourceScrape && isHostnameDifferent) {
          // TODO: re-fetch sitemap for redirect target domain
          sc.originUrl = doc.metadata.url;
          await saveCrawl(job.data.crawl_id, sc);
        }

        const p1 = generateURLPermutations(normalizeURL(doc.metadata.url, sc));
        const p2 = generateURLPermutations(
          normalizeURL(doc.metadata.sourceURL, sc),
        );

        if (JSON.stringify(p1) !== JSON.stringify(p2)) {
          logger.debug(
            "Was redirected, removing old URL and locking new URL...",
            { oldUrl: doc.metadata.sourceURL, newUrl: doc.metadata.url },
          );

          // Prevent redirect target from being visited in the crawl again
          // See lockURL
          const x = await (
            await crawlStateStore(job.data.crawl_id)
          ).sadd(
            "crawl:" + job.data.crawl_id + ":visited",
            ...p1.map(x => x.href),
          );
          const lockRes = x === p1.length;

          if (job.data.crawlerOptions !== null && !lockRes) {
            throw new RacedRedirectError();
          }
        }
      }

      if (crawler && sc) {
        if (!sc.cancelled) {
          const scCrawlerOptions = getStoredCrawlerOptions(sc);
          const baseUrl =
            doc.metadata.url ??
            doc.metadata.sourceURL ??
            sc.originUrl ??
            job.data.url;
          crawler.setBaseUrl(baseUrl);

          if (!scCrawlerOptions?.sitemapOnly) {
            const maxDepth = scCrawlerOptions?.maxDepth ?? 10;
            const links = await crawler.filterLinks(
              await crawler.extractLinksFromContent(
                rawHtml ?? "",
                baseUrl,
                doc.metadata?.contentType,
              ),
              Infinity,
              maxDepth,
            );
            logger.debug("Discovered " + links.links.length + " links...", {
              linksLength: links.links.length,
            });

            await recordRobotsBlocked(job.data.crawl_id, links.robotsBlocked);

            let discoveredLinks = links.links;
            if (job.data.crawl_id) {
              discoveredLinks = await applyCrawlLinksHook(discoveredLinks, {
                crawlId: job.data.crawl_id,
                ctx: {
                  ...ctx,
                  orgId: ctx.orgId ?? crawlContext(sc).orgId,
                },
                from: baseUrl,
                crawler,
                limit: Infinity,
                maxDepth,
                crawlerOptions: job.data.crawlerOptions,
                bypassBilling: job.data.internalOptions?.bypassBilling ?? false,
              });
            }

            const discoveredPriorityCtx =
              sc.team_id === ctx.teamId ? ctx : crawlContext(sc);
            let discoveredJobPriority: number | undefined;

            const crawlLimit = scCrawlerOptions?.limit;
            let remainingLimit =
              typeof crawlLimit === "number" && discoveredLinks.length > 0
                ? crawlLimit -
                  (await (
                    await crawlStateStore(job.data.crawl_id)
                  ).scard("crawl:" + job.data.crawl_id + ":visited_unique"))
                : Infinity;

            for (const link of discoveredLinks) {
              if (remainingLimit <= 0) {
                break;
              }
              if (await lockURL(job.data.crawl_id, sc, link)) {
                remainingLimit--;
                const jobPriority =
                  discoveredJobPriority ??
                  (discoveredJobPriority = await resolveJobPriority(
                    discoveredPriorityCtx,
                    job.data.crawl_id ? 20 : 10,
                    error => {
                      logger.error("Failed to determine job priority", {
                        error,
                      });
                    },
                  ));
                const jobId = uuidv7();

                logger.debug(
                  "Determined job priority " +
                    jobPriority +
                    " for URL " +
                    JSON.stringify(link),
                  { jobPriority, url: link },
                );

                await addScrapeJob(
                  {
                    url: link,
                    mode: "single_urls",
                    ctx: job.data.ctx,
                    team_id: sc.team_id,
                    scrapeOptions: getV2RequestSchemas().scrapeOptions.parse(
                      sc.scrapeOptions,
                    ),
                    internalOptions: sc.internalOptions,
                    crawlerOptions: {
                      ...scCrawlerOptions,
                      currentDiscoveryDepth:
                        (job.data.crawlerOptions?.currentDiscoveryDepth ?? 0) +
                        1,
                    },
                    origin: job.data.origin,
                    integration: job.data.integration,
                    crawl_id: job.data.crawl_id,
                    requestId: job.data.requestId,
                    billing: job.data.billing,
                    webhook: job.data.webhook,
                    v1: job.data.v1,
                    zeroDataRetention: job.data.zeroDataRetention,
                    apiKeyId: job.data.apiKeyId,
                    monitoring: job.data.monitoring
                      ? {
                          ...job.data.monitoring,
                          source: "discovered" as const,
                        }
                      : undefined,
                  },
                  jobId,
                  jobPriority,
                );

                await addCrawlJob(job.data.crawl_id, jobId, logger);
                logger.debug("Added job for URL " + JSON.stringify(link), {
                  jobPriority,
                  url: link,
                  newJobId: jobId,
                });
              } else {
                // TODO: removed this, ok? too many 'not useful' logs (?) Mogery!
                // logger.debug("Could not lock URL " + JSON.stringify(link), {
                //   url: link,
                // });
              }
            }
          }

          // Only run check after adding new jobs for discovery - mogery
          if (job.data.isCrawlSourceScrape) {
            const sourceUrl =
              doc.metadata.url ?? doc.metadata.sourceURL ?? job.data.url;
            const filterResult = await crawler.filterLinks(
              [sourceUrl],
              1,
              scCrawlerOptions?.maxDepth ?? 10,
              false,
              false,
              true,
            );
            if (filterResult.links.length === 0) {
              const reason =
                filterResult.denialReasons.get(sourceUrl) ||
                `The source URL ("${sourceUrl}") you provided as the starting point for this crawl is not allowed by your own crawl configuration. This can happen if your includePaths, excludePaths, maxDepth, or other filters exclude the starting URL itself. Please check your crawl configuration to ensure the starting URL is allowed.`;
              throw new CrawlDenialError(reason, {
                robotsBlockedUrl: filterResult.robotsBlocked.includes(sourceUrl)
                  ? sourceUrl
                  : null,
              });
            }
          }
        }
      }

      try {
        signal?.throwIfAborted();
      } catch {
        throw new ScrapeJobTimeoutError();
      }

      const credits_billed = await billScrapeJob(
        job,
        doc,
        costTracking,
        undefined,
        pipeline.unsupportedFeatures,
        pipeline.exchange,
        pipeline.threatDecisions,
      );
      successBilled = true;
      successBilledCredits = credits_billed ?? undefined;

      if (credits_billed !== undefined) {
        doc.metadata.creditsUsed = credits_billed;
      }

      const requestId = job.data.requestId ?? job.data.crawl_id ?? job.id;
      const storesExternally =
        Boolean(service.modules.jobStore.storesResultsExternally?.()) &&
        !job.data.skipNuq;
      try {
        await service.modules.jobStore.record(
          {
            id: job.id,
            kind: "scrape",
            ctx,
            requestId,
            url: job.data.url,
            options: job.data.scrapeOptions,
            creditsBilled: credits_billed ?? 0,
            timeTakenSeconds: timeTakenInSeconds,
            skipNuq: job.data.skipNuq ?? false,
            isParse: Boolean(job.data.internalOptions?.isParse),
          },
          { state: "completed", document: doc },
        );
      } catch (error: unknown) {
        logger.error("Failed to record completed scrape in job store", {
          error,
        });
        if (storesExternally) {
          throw error;
        }
      }

      if (job.data.v1) {
        const sender = await createWebhookSender({
          teamId: job.data.team_id,
          jobId: job.data.crawl_id,
          webhook: job.data.webhook,
          v0: false,
          zeroDataRetention: ctx.zeroDataRetention,
        });
        if (sender) {
          logger.debug("Calling webhook with success...", {
            webhook: summarizeWebhookForLog(job.data.webhook),
          });
          const documents = Array.isArray(data?.result?.links)
            ? data.result.links.map(x => x.content)
            : [];
          if (job.data.crawlerOptions !== null) {
            void sender.send(WebhookEvent.CRAWL_PAGE, {
              success: true,
              data: documents,
              scrapeId: job.id,
            });
          } else {
            void sender.send(WebhookEvent.BATCH_SCRAPE_PAGE, {
              success: true,
              data: documents,
              scrapeId: job.id,
            });
          }
        }
      }

      logger.debug("Declaring job as done...");
      try {
        await addCrawlJobDone(job.data.crawl_id, job.id, true, logger);
      } catch (error: unknown) {
        // The scrape succeeded and its success webhook already went out:
        // a bookkeeping failure must not route this job through the
        // failure path (contradictory failure webhook, misrecorded job).
        // Already logged canonically inside addCrawlJobDone.
        logger.error("Failed to mark successful crawl job as done", {
          crawlId: job.data.crawl_id,
          jobId: job.id,
          error,
        });
        // Durable fallback so the crawl's completion marker is retried by
        // the reconciler instead of being lost for good.
        await queueCrawlJobDoneRepair(job.data.crawl_id, job.id, true, logger);
      }

      finishedOutcome = {
        document: doc,
        charged: credits_billed ?? undefined,
        timeTakenMs: end - start,
        startedAt: start,
        completedAt: Date.now(),
        costTracking: costTracking.toJSON(),
        metadata: {
          jobData: job.data,
          exchange: pipeline.exchange,
          threatDecisions: pipeline.threatDecisions,
        },
      };
    } else {
      try {
        signal?.throwIfAborted();
      } catch {
        throw new ScrapeJobTimeoutError();
      }

      const credits_billed = await billScrapeJob(
        job,
        doc,
        costTracking,
        undefined,
        pipeline.unsupportedFeatures,
        pipeline.exchange,
        pipeline.threatDecisions,
      );
      successBilled = true;
      successBilledCredits = credits_billed ?? undefined;

      if (credits_billed !== undefined) {
        doc.metadata.creditsUsed = credits_billed;
      }

      const requestId = job.data.requestId ?? job.data.crawl_id ?? job.id;
      const storesExternally =
        Boolean(service.modules.jobStore.storesResultsExternally?.()) &&
        !job.data.skipNuq;
      const recordPromise = service.modules.jobStore.record(
        {
          id: job.id,
          kind: "scrape",
          ctx,
          requestId,
          url: job.data.url,
          options: job.data.scrapeOptions,
          creditsBilled: credits_billed ?? 0,
          timeTakenSeconds: timeTakenInSeconds,
          skipNuq: job.data.skipNuq ?? false,
          isParse: Boolean(job.data.internalOptions?.isParse),
        },
        { state: "completed", document: doc },
      );

      if (job.data.skipNuq) {
        const recordOutcomePromise = recordPromise
          .then(() => true)
          .catch((error: unknown) => {
            logger.error("Failed to record completed scrape in job store", {
              error,
            });
            return false;
          });
        const SCRAPE_STATE_BARRIER_MS = 2000;
        let barrierTimer: ReturnType<typeof setTimeout> | undefined;
        let recorded = false;
        try {
          recorded = await Promise.race([
            recordOutcomePromise,
            new Promise<false>(resolve => {
              barrierTimer = setTimeout(
                () => resolve(false),
                SCRAPE_STATE_BARRIER_MS,
              );
            }),
          ]);
        } finally {
          if (barrierTimer !== undefined) {
            clearTimeout(barrierTimer);
          }
        }
        if (!recorded) {
          logger.warn(
            "Sync scrape answered without a readable terminal state",
            {
              scrapeId: job.id,
            },
          );
        }
      } else {
        try {
          await recordPromise;
        } catch (error: unknown) {
          logger.error("Failed to record completed scrape in job store", {
            error,
          });
          if (storesExternally) {
            throw error;
          }
        }
      }

      finishedOutcome = {
        document: doc,
        charged: credits_billed ?? undefined,
        timeTakenMs: end - start,
        startedAt: start,
        completedAt: Date.now(),
        costTracking: costTracking.toJSON(),
        metadata: {
          jobData: job.data,
          exchange: pipeline.exchange,
          threatDecisions: pipeline.threatDecisions,
        },
      };
    }

    logger.info(`🐂 Job done ${job.id}`);
    resultData = data;
  } catch (error: unknown) {
    let credits_billed: number | null | undefined;
    let failureEnd: number | undefined;
    try {
      // Record top-level robots.txt rejections so crawl status can warn
      try {
        if (
          job.data.crawl_id &&
          job.data.crawlerOptions !== null &&
          error instanceof CrawlDenialError &&
          error.robotsBlockedUrl !== null
        ) {
          await recordRobotsBlocked(job.data.crawl_id, [
            error.robotsBlockedUrl,
          ]);
        }
      } catch (error_: unknown) {
        logger.debug("Failed to record top-level robots block", { e: error_ });
      }

      if (job.data.crawl_id) {
        const sc = await getCrawl(job.data.crawl_id);

        logger.debug("Declaring job as done...");
        try {
          await addCrawlJobDone(job.data.crawl_id, job.id, false, logger);
        } catch (error_: unknown) {
          // Already logged canonically inside addCrawlJobDone; a throw here
          // must not escape the error handler and fail the job a second time.
          logger.error("Failed to declare failed crawl job as done", {
            crawlId: job.data.crawl_id,
            jobId: job.id,
            error: error_,
          });
          await queueCrawlJobDoneRepair(
            job.data.crawl_id,
            job.id,
            false,
            logger,
          );
        }
        if (sc) {
          await (
            await crawlStateStore(job.data.crawl_id)
          ).srem(
            "crawl:" + job.data.crawl_id + ":visited_unique",
            normalizeURL(job.data.url, sc),
          );
        }

        await (
          await crawlStateStore(job.data.crawl_id)
        ).srem("crawl:" + job.data.crawl_id + ":jobs_qualified", job.id);
      }

      const isEarlyTimeout = error instanceof ScrapeJobTimeoutError;
      const isCancelled = error instanceof JobCancelledError;

      if (isEarlyTimeout) {
        logger.error(`🐂 Job timed out ${job.id}`);
      } else if (error instanceof RacedRedirectError) {
        logger.warn(`🐂 Job got redirect raced ${job.id}, silently failing`);
      } else if (isCancelled) {
        logger.warn(`🐂 Job got cancelled, silently failing`);
      } else {
        logger.error("🐂 Job errored", { jobId: job.id, error });

        logger.error(error);
        if (error instanceof Error && error.stack) {
          logger.error(error.stack);
        }
      }

      const data: ProcessJobResult = {
        success: false,
        document: null,
        error:
          error instanceof Error
            ? error
            : typeof error === "string"
              ? new Error(error)
              : new Error(JSON.stringify(error)),
      };

      try {
        // Ensure the parent `requests` row is committed before any child
        // `scrapes`/`parses` insert, to avoid a request_id FK violation. Runs on
        // both the crawl and single-scrape paths; only single scrapes actually
        // carry a logRequestPromise.
        if (job.data.logRequestPromise) {
          const start = Date.now();
          await job.data.logRequestPromise;
          const waited = Date.now() - start;
          if (waited > 0) {
            logger.warn("Had to wait for log request promise to complete", {
              timeMs: waited,
            });
          }
        }
      } catch {
        // Ignore request logging errors while already handling scrape failure.
      }

      if (job.data.crawl_id) {
        const sender = await createWebhookSender({
          teamId: job.data.team_id,
          jobId: job.data.crawl_id ?? job.id,
          webhook: job.data.webhook,
          v0: Boolean(!job.data.v1),
          zeroDataRetention: ctx.zeroDataRetention,
        });

        // at this point we don't have a document, send a minimal payload to let users identify the errored URL
        const metadata = {
          sourceURL: job.data.url,
        };

        if (sender) {
          if (job.data.crawlerOptions !== null) {
            void sender.send(WebhookEvent.CRAWL_PAGE, {
              success: false,
              error: data.error.message,
              data: [
                {
                  metadata,
                },
              ],
              scrapeId: job.id,
            });
          } else {
            void sender.send(WebhookEvent.BATCH_SCRAPE_PAGE, {
              success: false,
              error: data.error.message,
              data: [
                {
                  metadata,
                },
              ],
              scrapeId: job.id,
            });
          }
        }
      }

      const end = Date.now();
      failureEnd = end;
      const timeTakenInSeconds = (end - start) / 1000;

      credits_billed = successBilled
        ? successBilledCredits
        : await billScrapeJob(
            job,
            null,
            costTracking,
            error instanceof Error ? error : null,
            undefined,
            undefined,
            pipeline?.threatDecisions,
          );

      const requestId = job.data.requestId ?? job.data.crawl_id ?? job.id;
      const parsedError = errorWithMessageSchema.safeParse(error);
      const errorMessage =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : parsedError.success
              ? parsedError.data.message
              : "Something went wrong... Contact help@mendable.ai";

      try {
        await service.modules.jobStore.record(
          {
            id: job.id,
            kind: "scrape",
            ctx,
            requestId,
            url: job.data.url,
            options: job.data.scrapeOptions,
            creditsBilled: credits_billed ?? 0,
            timeTakenSeconds: timeTakenInSeconds,
            skipNuq: job.data.skipNuq ?? false,
            isParse: Boolean(job.data.internalOptions?.isParse),
          },
          { state: "failed", error: errorMessage },
        );
      } catch (recordError: unknown) {
        logger.error("Failed to record failed scrape in job store", {
          error: recordError,
        });
      }

      resultData = data;
    } catch (cleanupError: unknown) {
      failureCleanupError = cleanupError;
      hasFailureCleanupError = true;
    } finally {
      const completedAt = failureEnd ?? Date.now();
      finishedOutcome = {
        document: null,
        error,
        charged: credits_billed ?? undefined,
        timeTakenMs: completedAt - start,
        startedAt: start,
        completedAt,
        costTracking: costTracking.toJSON(),
        metadata: {
          jobData: job.data,
          exchange: pipeline?.success ? pipeline.exchange : undefined,
          threatDecisions: pipeline?.threatDecisions,
        },
      };
    }
  } finally {
    if (abortTimeoutHandle) {
      clearTimeout(abortTimeoutHandle);
    }
  }

  if (finishedOutcome) {
    if (hasFailureCleanupError) {
      try {
        await emitScrapeFinished(finishedOutcome);
      } catch (hookError: unknown) {
        logger.warn("scrape.finished handler failed after cleanup error", {
          error: hookError,
        });
      }
      throw failureCleanupError;
    }
    // Emit after the try/catch so a rejecting scrape.finished handler
    // propagates as an await hook without re-entering failure bookkeeping.
    await emitScrapeFinished(finishedOutcome);
  }

  if (!resultData) {
    throw new Error("Scrape job finished without result");
  }
  return resultData;
}

async function kickoffGetIndexLinks(
  crawlId: string,
  sc: StoredCrawl,
  crawler: WebCrawler,
  url: string,
  ctx: RequestContext,
) {
  const scCrawlerOptions = getStoredCrawlerOptions(sc);
  if (scCrawlerOptions?.ignoreSitemap || scCrawlerOptions?.sitemapOnly) {
    return [];
  }

  let index: Array<string> = [];

  const hooks = installedService()?.hooks;
  if (hooks?.has("crawl.kickoff")) {
    index = await hooks.transform("crawl.kickoff", index, {
      id: crawlId,
      ctx,
      url,
      crawlerOptions: scCrawlerOptions ?? undefined,
    });
  }

  if (index.length === 0) {
    return [];
  }

  const { links, robotsBlocked } = await crawler.filterLinks(
    index,
    scCrawlerOptions?.limit ?? 10_000,
    scCrawlerOptions?.maxDepth ?? 10,
    false,
  );
  await recordRobotsBlocked(crawlId, robotsBlocked);

  return links;
}

async function addKickoffSitemapJob(
  sitemapUrl: string,
  sourceJob: NuQJob<ScrapeJobKickoff | ScrapeJobKickoffSitemap>,
  sc: StoredCrawl,
  logger: Logger,
) {
  // TEMP: max 20 sitemaps per crawl
  if (
    (await (
      await crawlStateStore(sourceJob.data.crawl_id)
    ).scard("crawl:" + sourceJob.data.crawl_id + ":sitemaps")) >= 20
  ) {
    logger.debug("Sitemap limit reached, skipping...", { sitemap: sitemapUrl });
    return;
  }

  const sitemapLocked =
    (await (
      await crawlStateStore(sourceJob.data.crawl_id)
    ).sadd("crawl:" + sourceJob.data.crawl_id + ":sitemaps", sitemapUrl)) === 1;
  await (
    await crawlStateStore(sourceJob.data.crawl_id)
  ).expire("crawl:" + sourceJob.data.crawl_id + ":sitemaps", 24 * 60 * 60);
  if (!sitemapLocked) {
    logger.debug("Sitemap already hit, skipping...", { sitemap: sitemapUrl });
    return;
  }

  const jobId = uuidv7();
  await _addScrapeJobToBullMQ(
    {
      mode: "kickoff_sitemap" as const,
      ctx: sourceJob.data.ctx,
      team_id: sourceJob.data.team_id,
      zeroDataRetention:
        sourceJob.data.zeroDataRetention || (sc.zeroDataRetention ?? false),
      sitemapUrl,
      origin: sourceJob.data.origin,
      integration: sourceJob.data.integration,
      crawl_id: sourceJob.data.crawl_id,
      requestId: sourceJob.data.requestId,
      billing: sourceJob.data.billing,
      webhook: sourceJob.data.webhook,
      v1: sourceJob.data.v1,
      apiKeyId: sourceJob.data.apiKeyId,
      monitoring: sourceJob.data.monitoring
        ? { ...sourceJob.data.monitoring, source: "discovered" as const }
        : undefined,
    } satisfies ScrapeJobKickoffSitemap,
    jobId,
    21,
  );
  await (
    await crawlStateStore(sourceJob.data.crawl_id)
  ).sadd("crawl:" + sourceJob.data.crawl_id + ":sitemap_jobs", jobId);
  await (
    await crawlStateStore(sourceJob.data.crawl_id)
  ).expire("crawl:" + sourceJob.data.crawl_id + ":sitemap_jobs", 24 * 60 * 60);
}

async function processKickoffJob(
  job: NuQJob<ScrapeJobKickoff>,
): Promise<KickoffJobResult> {
  const ctx = jobContext(job.data);
  const logger = _logger.child({
    module: "queue-worker",
    method: "processKickoffJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
    zeroDataRetention: ctx.zeroDataRetention,
  });

  try {
    const sc = await getCrawl(job.data.crawl_id);
    if (!sc) {
      throw new Error("Crawl not found");
    }
    const scCrawlerOptions = getStoredCrawlerOptions(sc);
    const team = await installedService()?.modules.auth.lookupTeam?.(
      job.data.team_id,
    );
    const kickoffCtx = enrichContextWithTeam(ctx, team);
    const crawler = crawlToCrawler(
      job.data.crawl_id,
      sc,
      team?.flags ?? ctx.flags ?? null,
    );

    logger.debug("Locking URL...");
    await lockURL(job.data.crawl_id, sc, job.data.url);
    const jobId = uuidv7();
    logger.debug("Adding scrape job to Redis...", { jobId });
    await addScrapeJob(
      {
        url: job.data.url,
        mode: "single_urls",
        ctx: job.data.ctx,
        team_id: job.data.team_id,
        crawlerOptions: job.data.crawlerOptions,
        scrapeOptions: getV2RequestSchemas().scrapeOptions.parse(
          job.data.scrapeOptions,
        ),
        internalOptions: sc.internalOptions,
        origin: job.data.origin,
        integration: job.data.integration,
        crawl_id: job.data.crawl_id,
        requestId: job.data.requestId,
        billing: job.data.billing,
        webhook: job.data.webhook,
        v1: job.data.v1,
        isCrawlSourceScrape: true,
        zeroDataRetention: job.data.zeroDataRetention,
        apiKeyId: job.data.apiKeyId,
        monitoring: job.data.monitoring
          ? { ...job.data.monitoring, source: "discovered" as const }
          : undefined,
      },
      jobId,
      await resolveJobPriority(kickoffCtx, 15, error => {
        logger.error("Failed to determine job priority", { error });
      }),
    );
    logger.debug("Adding scrape job to BullMQ...", { jobId });
    await addCrawlJob(job.data.crawl_id, jobId, logger);

    if (job.data.webhook) {
      logger.debug("Calling webhook with crawl.started...", {
        webhook: summarizeWebhookForLog(job.data.webhook),
      });
      const sender = await createWebhookSender({
        teamId: job.data.team_id,
        jobId: job.data.crawl_id,
        webhook: job.data.webhook,
        v0: Boolean(!job.data.v1),
      });
      if (sender) {
        void sender.send(WebhookEvent.CRAWL_STARTED, { success: true });
      }
    }

    if (!scCrawlerOptions?.ignoreSitemap) {
      if (job.data.url.endsWith(".xml") || job.data.url.endsWith(".xml.gz")) {
        await addKickoffSitemapJob(job.data.url, job, sc, logger);
      } else {
        const urlObj = new URL(job.data.url);

        const attempts: Array<string> = crawler.robots.getSitemaps();

        // sitemap.xml in the directory the crawl is scoped to
        const urlWithSitemap = new URL(urlObj.href);
        urlWithSitemap.pathname =
          getCrawlScope(urlObj.href).prefix + "sitemap.xml";
        urlWithSitemap.search = "";
        urlWithSitemap.hash = "";

        // Scoped directory sitemap.xml and base /sitemap.xml
        attempts.push(
          urlWithSitemap.href,
          new URL("/sitemap.xml", urlObj.href).href,
        );

        // Root domain sitemap.xml. Skipped when the host has no registrable domain
        // (IP literals, localhost): assigning a null domain would stringify to the
        // literal hostname "null" and produce https://null/sitemap.xml.
        const rootDomain = parseHostname(urlObj.hostname).domain;
        if (rootDomain && rootDomain !== urlObj.hostname) {
          const urlRootSitemap = new URL("/sitemap.xml", urlObj.href);
          urlRootSitemap.hostname = rootDomain;
          attempts.push(urlRootSitemap.href);
        }

        for (const attempt of new Set(attempts)) {
          await addKickoffSitemapJob(attempt, job, sc, logger);
        }
      }
    }

    let indexLinks = await kickoffGetIndexLinks(
      job.data.crawl_id,
      sc,
      crawler,
      job.data.url,
      ctx,
    );

    indexLinks = await applyCrawlLinksHook(indexLinks, {
      crawlId: job.data.crawl_id,
      ctx: {
        ...ctx,
        orgId: ctx.orgId ?? crawlContext(sc).orgId,
      },
      from: job.data.url,
      crawler,
      limit: scCrawlerOptions?.limit ?? 10_000,
      maxDepth: scCrawlerOptions?.maxDepth ?? 10,
      fromMap: false,
      crawlerOptions: scCrawlerOptions,
      bypassBilling: sc.internalOptions?.bypassBilling ?? false,
    });

    if (indexLinks.length > 0) {
      logger.debug("Using index links of length " + indexLinks.length, {
        indexLinksLength: indexLinks.length,
      });

      const jobPriority = await resolveJobPriority(kickoffCtx, 21, error => {
        logger.error("Failed to determine job priority", { error });
      });
      logger.debug("Using job priority " + jobPriority, { jobPriority });

      const jobs = indexLinks.map(url => {
        const uuid = uuidv7();
        return {
          jobId: uuid,
          data: {
            url,
            mode: "single_urls" as const,
            ctx: job.data.ctx,
            team_id: job.data.team_id,
            crawlerOptions: job.data.crawlerOptions,
            scrapeOptions: job.data.scrapeOptions,
            internalOptions: sc.internalOptions,
            origin: job.data.origin,
            integration: job.data.integration,
            crawl_id: job.data.crawl_id,
            requestId: job.data.requestId,
            billing: job.data.billing,
            sitemapped: true,
            webhook: job.data.webhook,
            v1: job.data.v1,
            zeroDataRetention: job.data.zeroDataRetention,
            apiKeyId: job.data.apiKeyId,
            monitoring: job.data.monitoring
              ? { ...job.data.monitoring, source: "discovered" as const }
              : undefined,
          },
          priority: jobPriority,
        };
      });

      logger.debug("Locking URLs...");
      const lockedIds = await lockURLsIndividually(
        job.data.crawl_id,
        sc,
        jobs.map(x => ({ id: x.jobId, url: x.data.url })),
      );
      const lockedJobs = jobs.filter(x =>
        lockedIds.find(y => y.id === x.jobId),
      );
      logger.debug("Adding scrape jobs to Redis...");
      await addCrawlJobs(
        job.data.crawl_id,
        lockedJobs.map(x => x.jobId),
        logger,
      );
      logger.debug("Adding scrape jobs to BullMQ...");
      await addScrapeJobs(lockedJobs);
    }

    logger.debug("Done queueing jobs!");

    await finishCrawlKickoff(job.data.crawl_id);

    return { success: true };
  } catch (error: unknown) {
    logger.error("An error occurred!", { error });
    await finishCrawlKickoff(job.data.crawl_id);
    await setCrawlError(
      job.data.crawl_id,
      error instanceof Error
        ? error.message
        : "An unexpected error occurred during crawl setup",
    );
    return { success: false, error };
  }
}

async function processKickoffSitemapJob(
  job: NuQJob<ScrapeJobKickoffSitemap>,
): Promise<KickoffJobResult> {
  const ctx = jobContext(job.data);
  const logger = _logger.child({
    module: "queue-worker",
    method: "processKickoffSitemapJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data.crawl_id,
    zeroDataRetention: ctx.zeroDataRetention,
  });

  const sc = await getCrawl(job.data.crawl_id);

  try {
    if (!sc) {
      logger.error("Crawl not found");
      return { success: false, error: "Crawl not found" };
    }
    const scCrawlerOptions = getStoredCrawlerOptions(sc);

    const team = await installedService()?.modules.auth.lookupTeam?.(
      job.data.team_id,
    );
    const sitemapCtx = enrichContextWithTeam(ctx, team);
    const crawler = crawlToCrawler(
      job.data.crawl_id,
      sc,
      team?.flags ?? ctx.flags ?? null,
    );

    const results = await scrapeSitemap({
      url: job.data.sitemapUrl,
      maxAge: 48 * 60 * 60 * 1000,
      zeroDataRetention: ctx.zeroDataRetention,
      usOnly: crawler.usOnly,
      location: job.data.location,
      crawlId: job.data.crawl_id,
      logger,
      isPreCrawl: sc.internalOptions?.isPreCrawl ?? false,
    });

    const maxDepth = scCrawlerOptions?.maxDepth ?? 10;
    const sitemapLinks = await crawler.filterLinks(
      results.urls.map(x => x.href),
      Infinity,
      maxDepth,
      false,
    );
    await recordRobotsBlocked(job.data.crawl_id, sitemapLinks.robotsBlocked);
    const passingURLs = await applyCrawlLinksHook(sitemapLinks.links, {
      crawlId: job.data.crawl_id,
      ctx: {
        ...ctx,
        orgId: ctx.orgId ?? crawlContext(sc).orgId,
      },
      from: job.data.sitemapUrl,
      crawler,
      limit: Infinity,
      maxDepth,
      fromMap: false,
      crawlerOptions: scCrawlerOptions,
      bypassBilling: sc.internalOptions?.bypassBilling ?? false,
    });

    if (passingURLs.length > 0) {
      logger.debug("Using urls of length " + passingURLs.length, {
        urlsLength: passingURLs.length,
      });

      const jobPriority = await resolveJobPriority(sitemapCtx, 21, error => {
        logger.error("Failed to determine job priority", { error });
      });

      const jobs = passingURLs.map(url => ({
        data: {
          url,
          mode: "single_urls" as const,
          ctx: job.data.ctx,
          team_id: job.data.team_id,
          crawlerOptions: scCrawlerOptions,
          scrapeOptions: sc.scrapeOptions,
          internalOptions: sc.internalOptions,
          origin: job.data.origin,
          integration: job.data.integration,
          crawl_id: job.data.crawl_id,
          requestId: job.data.requestId,
          billing: job.data.billing,
          sitemapped: true,
          webhook: job.data.webhook,
          v1: job.data.v1,
          zeroDataRetention:
            job.data.zeroDataRetention || (sc.zeroDataRetention ?? false),
          apiKeyId: job.data.apiKeyId,
          monitoring: job.data.monitoring
            ? { ...job.data.monitoring, source: "discovered" as const }
            : undefined,
        } satisfies ScrapeJobSingleUrls,
        jobId: uuidv7(),
        priority: jobPriority,
      }));

      const urls = await lockURLsIndividually(
        job.data.crawl_id,
        sc,
        jobs.map(x => ({ id: x.jobId, url: x.data.url })),
      );
      const winningIds = new Set(urls.map(x => x.id));
      await addCrawlJobs(
        job.data.crawl_id,
        urls.map(x => x.id),
        logger,
      );
      await addScrapeJobs(jobs.filter(x => winningIds.has(x.jobId)));

      logger.debug("Done queueing jobs!");
    }

    if (results.sitemaps.length > 0) {
      logger.debug("Using sitemaps of length " + results.sitemaps.length, {
        sitemapsLength: results.sitemaps.length,
      });

      for (const sitemap of results.sitemaps) {
        await addKickoffSitemapJob(sitemap.href, job, sc, logger);
      }

      logger.debug("Done queueing sitemap jobs!");
    }
    return { success: true };
  } catch (error: unknown) {
    if (error instanceof SitemapError && error.cause === 404) {
      logger.debug("Sitemap not found", { sitemapUrl: job.data.sitemapUrl });
    } else {
      logger.error("An error occurred!", { error });
    }
    return { success: false, error };
  } finally {
    await (
      await crawlStateStore(job.data.crawl_id)
    ).sadd("crawl:" + job.data.crawl_id + ":sitemap_jobs_done", job.id);
    await (
      await crawlStateStore(job.data.crawl_id)
    ).expire("crawl:" + job.data.crawl_id + ":sitemap_jobs_done", 24 * 60 * 60);
  }
}

export const processJobInternal = async (job: NuQJob<ScrapeJobData>) => {
  const ctx = jobContext(job.data);
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJobInternal",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    zeroDataRetention: ctx.zeroDataRetention,
  });

  // Restore trace context if available and execute within span. The ZDR
  // context is applied either way so nothing below records for ZDR jobs.
  return withZeroDataRetention(ctx.zeroDataRetention, () => {
    if (!job.data.traceContext) {
      return processJobWithTracing(job, logger);
    }

    return withTraceContextAsync(job.data.traceContext, () =>
      withSpan("worker.scrape.process", async span => {
        setSpanAttributes(span, {
          "worker.job_id": job.id,
          "worker.mode": job.data.mode,
          "worker.team_id": job.data.team_id,
          "worker.crawl_id": job.data.crawl_id || "none",
          "worker.url": job.data.mode === "single_urls" ? job.data.url : "n/a",
        });

        return processJobWithTracing(job, logger);
      }),
    );
  });
};

async function processJobWithTracing(
  job: NuQJob<ScrapeJobData>,
  logger: Logger,
) {
  // FDB-backed jobs hold their concurrency slot through the queue lease; the
  // Redis slot mirror and promotion-on-done below are PG-backend machinery
  const isFdbJob = "backend" in job && job.backend === "fdb";
  try {
    try {
      let extendLockInterval: NodeJS.Timeout | null = null;
      if (
        !isFdbJob &&
        job.data?.mode !== "kickoff" &&
        job.data?.team_id &&
        !job.data.skipNuq
      ) {
        extendLockInterval = setInterval(() => {
          void pushConcurrencyLimitActiveJob(
            job.data.team_id,
            job.id,
            60 * 1000,
          ); // 60s lock renew, just like in the queue
        }, jobLockExtendInterval);
      }

      await installedService()?.modules.limits.onJobStart?.(
        job.data.team_id,
        job.id,
      );
      try {
        if (job.data.mode === "kickoff") {
          const result = await processKickoffJob({
            ...job,
            data: job.data,
          });
          if (result.success) {
            return null;
          } else {
            throw result.error;
          }
        } else if (job.data.mode === "kickoff_sitemap") {
          const result = await processKickoffSitemapJob({
            ...job,
            data: job.data,
          });
          if (result.success) {
            return null;
          } else {
            throw result.error;
          }
        } else {
          const result = await processJob({
            ...job,
            data: job.data,
          });
          if (result.success) {
            try {
              if (job.data.team_id) {
                await redisEvictConnection.set(
                  "most-recent-success:" + job.data.team_id,
                  new Date().toISOString(),
                  "EX",
                  60 * 60 * 24,
                );
              }
            } catch (error: unknown) {
              logger.warn("Failed to set most recent success", { error });
            }

            if (
              service.modules.jobStore.storesResultsExternally?.() &&
              !job.data.skipNuq
            ) {
              logger.debug("Job succeeded -- putting null in queue");
              return null;
            }
            logger.debug("Job succeeded -- putting result in queue");
            return result.document;
          } else {
            throw result.error;
          }
        }
      } finally {
        await installedService()?.modules.limits.onJobEnd?.(
          job.data.team_id,
          job.id,
        );
        if (extendLockInterval) {
          clearInterval(extendLockInterval);
        }
      }
    } finally {
      if (!job.data.skipNuq && !isFdbJob) {
        await concurrentJobDone(job);
      }
    }
  } catch (error: unknown) {
    logger.warn("Job failed", { error });

    if (job.data.skipNuq) {
      throw error;
    } else {
      throw new Error(serializeThrownError(error), { cause: error });
    }
  }
}

const exitHandler = () => {
  process.exit(0);
};

if (require.main === module) {
  process.on("SIGINT", exitHandler);
  process.on("SIGTERM", exitHandler);
  process.on("exit", exitHandler);
}
