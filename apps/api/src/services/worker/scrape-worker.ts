import { configDotenv } from "dotenv";
import { config } from "../../config";
import * as Sentry from "@sentry/node";
import { applyZdrScope, captureExceptionWithZdrCheck } from "../sentry";
import http from "http";
import https from "https";

import { logger as _logger } from "../../lib/logger";
import {
  concurrentJobDone,
  pushConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { addJobPriority, deleteJobPriority } from "../../lib/job-priority";
import { cacheableLookup } from "../../scraper/scrapeURL/lib/cacheableLookup";
import { v7 as uuidv7 } from "uuid";
import {
  addCrawlJob,
  addCrawlJobs,
  addCrawlJobDone,
  crawlToCrawler,
  recordRobotsBlocked,
  finishCrawlKickoff,
  generateURLPermutations,
  getCrawl,
  lockURL,
  lockURLsIndividually,
  normalizeURL,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { redisEvictConnection } from "../redis";
import {
  _addScrapeJobToBullMQ,
  addScrapeJob,
  addScrapeJobs,
} from "../queue-jobs";
import psl from "psl";
import { getJobPriority } from "../../lib/job-priority";
import { Document, scrapeOptions, TeamFlags } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";
import { getACUCTeam } from "../../controllers/auth";
import { createWebhookSender, WebhookEvent } from "../webhook/index";
import { CustomError } from "../../lib/custom-error";
import { startWebScraperPipeline } from "../../main/runWebScraper";
import { CostTracking } from "../../lib/cost-tracking";
import { normalizeUrlOnlyHostname } from "../../lib/canonical-url";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { generateURLSplits, queryIndexAtSplitLevel } from "../index";
import { WebCrawler } from "../../scraper/WebScraper/crawler";
import { calculateCreditsToBeBilled } from "../../lib/scrape-billing";
import { getBillingQueue } from "../queue-service";
import type { Logger } from "winston";
import {
  CrawlDenialError,
  RacedRedirectError,
  ScrapeJobTimeoutError,
  TransportableError,
  UnknownError,
} from "../../lib/error";
import { serializeTransportableError } from "../../lib/error-serde";
import type { NuQJob } from "./nuq";
import {
  ScrapeJobData,
  ScrapeJobKickoff,
  ScrapeJobKickoffSitemap,
  ScrapeJobSingleUrls,
} from "../../types";
import { scrapeSitemap } from "../../scraper/crawler/sitemap";
import {
  withTraceContextAsync,
  withSpan,
  setSpanAttributes,
} from "../../lib/otel-tracer";
import { ScrapeUrlResponse } from "../../scraper/scrapeURL";
import { logScrape } from "../logging/log_job";
import { FeatureFlag } from "../../scraper/scrapeURL/engines";

configDotenv();

const jobLockExtendInterval = config.JOB_LOCK_EXTEND_INTERVAL;
const jobLockExtensionTime = config.JOB_LOCK_EXTENSION_TIME;

if (require.main === module) {
  cacheableLookup.install(http.globalAgent);
  cacheableLookup.install(https.globalAgent);
}

async function billScrapeJob(
  job: NuQJob<any>,
  document: Document | null,
  logger: Logger,
  costTracking: CostTracking,
  flags: TeamFlags,
  error?: Error | null,
  unsupportedFeatures?: Set<FeatureFlag>,
) {
  let creditsToBeBilled: number | null = null;

  if (job.data.is_scrape !== true && !job.data.internalOptions?.bypassBilling) {
    creditsToBeBilled = await calculateCreditsToBeBilled(
      job.data.scrapeOptions,
      job.data.internalOptions,
      document,
      costTracking,
      flags,
      error,
      unsupportedFeatures,
    );

    if (
      job.data.team_id !== config.BACKGROUND_INDEX_TEAM_ID! &&
      config.USE_DB_AUTHENTICATION
    ) {
      try {
        const billingJobId = uuidv7();
        logger.debug(
          `Adding billing job to queue for team ${job.data.team_id}`,
          {
            billingJobId,
            credits: creditsToBeBilled,
            is_extract: false,
          },
        );

        // Add directly to the billing queue - the billing worker will handle the rest
        await getBillingQueue().add(
          "bill_team",
          {
            team_id: job.data.team_id,
            subscription_id: undefined,
            credits: creditsToBeBilled,
            is_extract: false,
            timestamp: new Date().toISOString(),
            originating_job_id: job.id,
            api_key_id: job.data.apiKeyId,
          },
          {
            jobId: billingJobId,
            priority: 10,
          },
        );
        return creditsToBeBilled;
      } catch (error) {
        logger.error(
          `Failed to add billing job to queue for team ${job.data.team_id} for ${creditsToBeBilled} credits`,
          { error },
        );
        captureExceptionWithZdrCheck(error, {
          extra: { zeroDataRetention: job.data.zeroDataRetention ?? false },
        });
        return creditsToBeBilled;
      }
    }
  }

  return creditsToBeBilled;
}

async function processJob(job: NuQJob<ScrapeJobSingleUrls>) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
    zeroDataRetention: job.data?.zeroDataRetention ?? false,
  });
  applyZdrScope(job.data?.zeroDataRetention);
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
          () =>
            abortController.abort(
              new ScrapeJobTimeoutError("Scrape timed out"),
            ),
          remainingTime,
        )
      : undefined;
  const signal = abortController.signal;

  try {
    if (remainingTime !== undefined && remainingTime < 0) {
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
      if (sc && sc.cancelled) {
        throw new Error("Parent crawl/batch scrape was cancelled");
      }
    }

    let pipeline: ScrapeUrlResponse | null = null;
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

                throw new ScrapeJobTimeoutError("Scrape timed out");
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
    } catch (e) {
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }

    if (!pipeline.success) {
      throw pipeline.error;
    }

    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    const doc = pipeline.document;

    const rawHtml = doc.rawHtml ?? "";

    if (!hasFormatOfType(job.data.scrapeOptions.formats, "rawHtml")) {
      delete doc.rawHtml;
    }

    if (job.data.concurrencyLimited) {
      doc.warning =
        "This scrape job was throttled at your current concurrency limit. If you'd like to scrape faster, you can upgrade your plan." +
        (doc.warning ? " " + doc.warning : "");
    }

    const data = {
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

    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

      if (
        doc.metadata.url !== undefined &&
        doc.metadata.sourceURL !== undefined &&
        normalizeURL(doc.metadata.url, sc) !==
          normalizeURL(doc.metadata.sourceURL, sc) &&
        job.data.crawlerOptions !== null // only on crawls, don't care on batch scrape
      ) {
        const crawler = crawlToCrawler(
          job.data.crawl_id,
          sc,
          (await getACUCTeam(job.data.team_id))?.flags ?? null,
        );
        const filterResult = await crawler.filterURL(
          doc.metadata.url,
          doc.metadata.sourceURL,
        );
        if (!filterResult.allowed && !job.data.isCrawlSourceScrape) {
          const reason =
            filterResult.denialReason ||
            "Redirected target URL is not allowed by crawlOptions";
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

        if (
          isUrlBlocked(
            doc.metadata.url,
            (await getACUCTeam(job.data.team_id))?.flags ?? null,
          )
        ) {
          throw new CrawlDenialError(BLOCKLISTED_URL_MESSAGE); // TODO: make this its own error type that is ignored by error tracking
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
          const x = await redisEvictConnection.sadd(
            "crawl:" + job.data.crawl_id + ":visited",
            ...p1.map(x => x.href),
          );
          const lockRes = x === p1.length;

          if (job.data.crawlerOptions !== null && !lockRes) {
            throw new RacedRedirectError();
          }
        }
      }

      if (job.data.crawlerOptions !== null) {
        if (!sc.cancelled) {
          const crawler = crawlToCrawler(
            job.data.crawl_id,
            sc,
            (await getACUCTeam(job.data.team_id))?.flags ?? null,
            doc.metadata.url ?? doc.metadata.sourceURL ?? sc.originUrl!,
            job.data.crawlerOptions,
          );

          const links = await crawler.filterLinks(
            await crawler.extractLinksFromHTML(
              rawHtml ?? "",
              doc.metadata?.url ?? doc.metadata?.sourceURL ?? sc.originUrl!,
            ),
            Infinity,
            sc.crawlerOptions?.maxDepth ?? 10,
          );
          logger.debug("Discovered " + links.links.length + " links...", {
            linksLength: links.links.length,
          });

          // Store robots blocked URLs in Redis set
          for (const [url, reason] of links.denialReasons) {
            if (reason === "URL blocked by robots.txt") {
              await recordRobotsBlocked(job.data.crawl_id, url);
            }
          }

          for (const link of links.links) {
            if (await lockURL(job.data.crawl_id, sc, link)) {
              // This seems to work really welel
              const jobPriority = await getJobPriority({
                team_id: sc.team_id,
                basePriority: job.data.crawl_id ? 20 : 10,
              });
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
                  team_id: sc.team_id,
                  scrapeOptions: scrapeOptions.parse(sc.scrapeOptions),
                  internalOptions: sc.internalOptions,
                  crawlerOptions: {
                    ...sc.crawlerOptions,
                    currentDiscoveryDepth:
                      (job.data.crawlerOptions?.currentDiscoveryDepth ?? 0) + 1,
                  },
                  origin: job.data.origin,
                  integration: job.data.integration,
                  crawl_id: job.data.crawl_id,
                  requestId: job.data.requestId,
                  webhook: job.data.webhook,
                  v1: job.data.v1,
                  zeroDataRetention: job.data.zeroDataRetention,
                  apiKeyId: job.data.apiKeyId,
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

          // Only run check after adding new jobs for discovery - mogery
          if (job.data.isCrawlSourceScrape) {
            const filterResult = await crawler.filterLinks(
              [doc.metadata.url ?? doc.metadata.sourceURL!],
              1,
              sc.crawlerOptions?.maxDepth ?? 10,
            );
            if (filterResult.links.length === 0) {
              const url = doc.metadata.url ?? doc.metadata.sourceURL!;
              const reason =
                filterResult.denialReasons.get(url) ||
                "Source URL is not allowed by crawl configuration";
              throw new CrawlDenialError(reason);
            }
          }
        }
      }

      try {
        signal?.throwIfAborted();
      } catch (e) {
        throw new ScrapeJobTimeoutError("Scrape timed out");
      }

      const credits_billed = await billScrapeJob(
        job,
        doc,
        logger,
        costTracking,
        (await getACUCTeam(job.data.team_id))?.flags ?? null,
        undefined,
        pipeline.unsupportedFeatures,
      );

      doc.metadata.creditsUsed = credits_billed ?? undefined;

      logger.debug("Logging job to DB...");
      await logScrape(
        {
          id: job.id,
          request_id: job.data.requestId ?? job.data.crawl_id ?? job.id,
          url: job.data.url,
          is_successful: true,
          doc,
          time_taken: timeTakenInSeconds,
          team_id: job.data.team_id,
          options: job.data.scrapeOptions,
          cost_tracking: costTracking.toJSON(),
          pdf_num_pages: doc.metadata.numPages,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention: job.data.zeroDataRetention,
          skipNuq: job.data.skipNuq ?? false,
        },
        true,
      );

      if (job.data.v1) {
        const sender = await createWebhookSender({
          teamId: job.data.team_id,
          jobId: job.data.crawl_id,
          webhook: job.data.webhook,
          v0: false,
        });
        if (sender) {
          logger.debug("Calling webhook with success...", {
            webhook: job.data.webhook,
          });
          const documents = Array.isArray(data?.result?.links)
            ? data.result.links.map(x => x.content)
            : [];
          if (job.data.crawlerOptions !== null) {
            sender.send(WebhookEvent.CRAWL_PAGE, {
              success: true,
              data: documents,
              scrapeId: job.id,
            });
          } else {
            sender.send(WebhookEvent.BATCH_SCRAPE_PAGE, {
              success: true,
              data: documents,
              scrapeId: job.id,
            });
          }
        }
      }

      logger.debug("Declaring job as done...");
      await addCrawlJobDone(job.data.crawl_id, job.id, true, logger);
    } else {
      try {
        signal?.throwIfAborted();
      } catch (e) {
        throw new ScrapeJobTimeoutError("Scrape timed out");
      }

      const credits_billed = await billScrapeJob(
        job,
        doc,
        logger,
        costTracking,
        (await getACUCTeam(job.data.team_id))?.flags ?? null,
        undefined,
        pipeline.unsupportedFeatures,
      );

      doc.metadata.creditsUsed = credits_billed ?? undefined;

      await logScrape(
        {
          id: job.id,
          request_id: job.data.requestId ?? job.data.crawl_id ?? job.id,
          url: job.data.url,
          is_successful: true,
          doc,
          time_taken: timeTakenInSeconds,
          team_id: job.data.team_id,
          options: job.data.scrapeOptions,
          cost_tracking: costTracking.toJSON(),
          pdf_num_pages: doc.metadata.numPages,
          credits_cost: credits_billed ?? 0,
          zeroDataRetention: job.data.zeroDataRetention,
          skipNuq: job.data.skipNuq ?? false,
        },
        false,
      );
    }

    logger.info(`🐂 Job done ${job.id}`);
    return data;
  } catch (error) {
    // Record top-level robots.txt rejections so crawl status can warn
    try {
      if (
        job.data.crawl_id &&
        job.data.crawlerOptions !== null &&
        error instanceof CrawlDenialError &&
        error.reason === "URL blocked by robots.txt"
      ) {
        await recordRobotsBlocked(job.data.crawl_id, job.data.url);
      }
    } catch (e) {
      logger.debug("Failed to record top-level robots block", { e });
    }

    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

      logger.debug("Declaring job as done...");
      await addCrawlJobDone(job.data.crawl_id, job.id, false, logger);
      await redisEvictConnection.srem(
        "crawl:" + job.data.crawl_id + ":visited_unique",
        normalizeURL(job.data.url, sc),
      );

      await redisEvictConnection.srem(
        "crawl:" + job.data.crawl_id + ":jobs_qualified",
        job.id,
      );
    }

    const isEarlyTimeout = error instanceof ScrapeJobTimeoutError;
    const isCancelled =
      error instanceof Error &&
      error.message === "Parent crawl/batch scrape was cancelled";

    if (isEarlyTimeout) {
      logger.error(`🐂 Job timed out ${job.id}`);
    } else if (error instanceof RacedRedirectError) {
      logger.warn(`🐂 Job got redirect raced ${job.id}, silently failing`);
    } else if (isCancelled) {
      logger.warn(`🐂 Job got cancelled, silently failing`);
    } else {
      logger.error(`🐂 Job errored ${job.id} - ${error}`, { error });

      // Filter out TransportableErrors (flow control)
      if (!(error instanceof TransportableError)) {
        captureExceptionWithZdrCheck(error, {
          data: {
            job: job.id,
          },
          extra: { zeroDataRetention: job.data.zeroDataRetention ?? false },
        });
      }

      if (error instanceof CustomError) {
        // Here we handle the error, then save the failed job
        logger.error(error.message); // or any other error handling
      }
      logger.error(error);
      if (error.stack) {
        logger.error(error.stack);
      }
    }

    const data = {
      success: false,
      document: null,
      error:
        error instanceof Error
          ? error
          : typeof error === "string"
            ? new Error(error)
            : new Error(JSON.stringify(error)),
    };

    if (job.data.crawl_id) {
      const sender = await createWebhookSender({
        teamId: job.data.team_id,
        jobId: (job.data.crawl_id ?? job.id) as string,
        webhook: job.data.webhook,
        v0: Boolean(!job.data.v1),
      });

      // at this point we don't have a document, send a minimal payload to let users identify the errored URL
      const metadata = {
        sourceURL: job.data.url,
      } as any;

      if (sender) {
        if (job.data.crawlerOptions !== null) {
          sender.send(WebhookEvent.CRAWL_PAGE, {
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
          sender.send(WebhookEvent.BATCH_SCRAPE_PAGE, {
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
    const timeTakenInSeconds = (end - start) / 1000;

    const credits_billed = await billScrapeJob(
      job,
      null,
      logger,
      costTracking,
      (await getACUCTeam(job.data.team_id))?.flags ?? null,
      error instanceof Error ? error : null,
    );

    logger.debug("Logging job to DB...");
    await logScrape(
      {
        id: job.id,
        request_id: job.data.requestId ?? job.data.crawl_id ?? job.id,
        url: job.data.url,
        is_successful: false,
        error:
          typeof error === "string"
            ? error
            : (error.message ??
              "Something went wrong... Contact help@mendable.ai"),
        time_taken: timeTakenInSeconds,
        team_id: job.data.team_id,
        options: job.data.scrapeOptions,
        cost_tracking: costTracking.toJSON(),
        credits_cost: credits_billed ?? 0,
        zeroDataRetention: job.data.zeroDataRetention,
        skipNuq: job.data.skipNuq ?? false,
      },
      true,
    );
    return data;
  } finally {
    if (abortTimeoutHandle) clearTimeout(abortTimeoutHandle);
  }
}

async function kickoffGetIndexLinks(
  sc: StoredCrawl,
  crawler: WebCrawler,
  url: string,
) {
  if (sc.crawlerOptions.ignoreSitemap) {
    return [];
  }

  const trimmedURL = new URL(url);
  trimmedURL.search = "";

  const index = await queryIndexAtSplitLevel(
    sc.crawlerOptions.allowBackwardCrawling
      ? generateURLSplits(trimmedURL.href)[0]
      : trimmedURL.href,
    sc.crawlerOptions.limit ?? 10000,
  );

  const validIndexLinksResult = await crawler.filterLinks(
    index,
    sc.crawlerOptions.limit ?? 10000,
    sc.crawlerOptions.maxDepth ?? 10,
    false,
  );
  const validIndexLinks = validIndexLinksResult.links;

  return validIndexLinks;
}

async function addKickoffSitemapJob(
  sitemapUrl: string,
  sourceJob: NuQJob<ScrapeJobKickoff | ScrapeJobKickoffSitemap>,
  sc: StoredCrawl,
  logger: Logger,
) {
  // TEMP: max 20 sitemaps per crawl
  if (
    (await redisEvictConnection.scard(
      "crawl:" + sourceJob.data.crawl_id + ":sitemaps",
    )) >= 20
  ) {
    logger.debug("Sitemap limit reached, skipping...", { sitemap: sitemapUrl });
    return;
  }

  const sitemapLocked =
    (await redisEvictConnection.sadd(
      "crawl:" + sourceJob.data.crawl_id + ":sitemaps",
      sitemapUrl,
    )) === 1;
  await redisEvictConnection.expire(
    "crawl:" + sourceJob.data.crawl_id + ":sitemaps",
    24 * 60 * 60,
  );
  if (!sitemapLocked) {
    logger.debug("Sitemap already hit, skipping...", { sitemap: sitemapUrl });
    return;
  }

  const jobId = uuidv7();
  await _addScrapeJobToBullMQ(
    {
      mode: "kickoff_sitemap" as const,
      team_id: sourceJob.data.team_id,
      zeroDataRetention:
        sourceJob.data.zeroDataRetention || (sc.zeroDataRetention ?? false),
      sitemapUrl: sitemapUrl,
      origin: sourceJob.data.origin,
      integration: sourceJob.data.integration,
      crawl_id: sourceJob.data.crawl_id,
      requestId: sourceJob.data.requestId,
      webhook: sourceJob.data.webhook,
      v1: sourceJob.data.v1,
      apiKeyId: sourceJob.data.apiKeyId,
    } satisfies ScrapeJobKickoffSitemap,
    jobId,
    21,
  );
  await redisEvictConnection.sadd(
    "crawl:" + sourceJob.data.crawl_id + ":sitemap_jobs",
    jobId,
  );
  await redisEvictConnection.expire(
    "crawl:" + sourceJob.data.crawl_id + ":sitemap_jobs",
    24 * 60 * 60,
  );
}

async function processKickoffJob(job: NuQJob<ScrapeJobKickoff>) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processKickoffJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
    zeroDataRetention: job.data.zeroDataRetention ?? false,
  });

  try {
    const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
    const crawler = crawlToCrawler(
      job.data.crawl_id,
      sc,
      (await getACUCTeam(job.data.team_id))?.flags ?? null,
    );

    logger.debug("Locking URL...");
    await lockURL(job.data.crawl_id, sc, job.data.url);
    const jobId = uuidv7();
    logger.debug("Adding scrape job to Redis...", { jobId });
    await addScrapeJob(
      {
        url: job.data.url,
        mode: "single_urls",
        team_id: job.data.team_id,
        crawlerOptions: job.data.crawlerOptions,
        scrapeOptions: scrapeOptions.parse(job.data.scrapeOptions),
        internalOptions: sc.internalOptions,
        origin: job.data.origin,
        integration: job.data.integration,
        crawl_id: job.data.crawl_id,
        requestId: job.data.requestId,
        webhook: job.data.webhook,
        v1: job.data.v1,
        isCrawlSourceScrape: true,
        zeroDataRetention: job.data.zeroDataRetention,
        apiKeyId: job.data.apiKeyId,
      },
      jobId,
      await getJobPriority({ team_id: job.data.team_id, basePriority: 15 }),
    );
    logger.debug("Adding scrape job to BullMQ...", { jobId });
    await addCrawlJob(job.data.crawl_id, jobId, logger);

    if (job.data.webhook) {
      logger.debug("Calling webhook with crawl.started...", {
        webhook: job.data.webhook,
      });
      const sender = await createWebhookSender({
        teamId: job.data.team_id,
        jobId: job.data.crawl_id,
        webhook: job.data.webhook,
        v0: Boolean(!job.data.v1),
      });
      if (sender) {
        sender.send(WebhookEvent.CRAWL_STARTED, { success: true });
      }
    }

    if (!sc.crawlerOptions.ignoreSitemap) {
      if (job.data.url.endsWith(".xml") || job.data.url.endsWith(".xml.gz")) {
        await addKickoffSitemapJob(job.data.url, job, sc, logger);
      } else {
        const urlObj = new URL(job.data.url);

        const attempts: string[] = crawler.robots.getSitemaps();

        // Append sitemap.xml
        const urlWithSitemap = new URL(urlObj.href);
        urlWithSitemap.pathname =
          urlWithSitemap.pathname +
          (urlObj.pathname.endsWith("/") ? "" : "/") +
          "sitemap.xml";
        urlWithSitemap.search = "";
        urlWithSitemap.hash = "";
        attempts.push(urlWithSitemap.href);

        // Base sitemap.xml
        attempts.push(new URL("/sitemap.xml", urlObj.href).href);

        // Root domain sitemap.xml
        const urlRootSitemap = new URL("/sitemap.xml", urlObj.href);
        urlRootSitemap.hostname = psl.parse(urlObj.hostname).domain;
        attempts.push(urlRootSitemap.href);

        for (const attempt of attempts) {
          await addKickoffSitemapJob(attempt, job, sc, logger);
        }
      }
    }

    const indexLinks = await kickoffGetIndexLinks(sc, crawler, job.data.url);

    if (indexLinks.length > 0) {
      logger.debug("Using index links of length " + indexLinks.length, {
        indexLinksLength: indexLinks.length,
      });

      let jobPriority = await getJobPriority({
        team_id: job.data.team_id,
        basePriority: 21,
      });
      logger.debug("Using job priority " + jobPriority, { jobPriority });

      const jobs = indexLinks.map(url => {
        const uuid = uuidv7();
        return {
          jobId: uuid,
          data: {
            url,
            mode: "single_urls" as const,
            team_id: job.data.team_id,
            crawlerOptions: job.data.crawlerOptions,
            scrapeOptions: job.data.scrapeOptions,
            internalOptions: sc.internalOptions,
            origin: job.data.origin,
            integration: job.data.integration,
            crawl_id: job.data.crawl_id,
            requestId: job.data.requestId,
            sitemapped: true,
            webhook: job.data.webhook,
            v1: job.data.v1,
            zeroDataRetention: job.data.zeroDataRetention,
            apiKeyId: job.data.apiKeyId,
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
  } catch (error) {
    logger.error("An error occurred!", { error });
    await finishCrawlKickoff(job.data.crawl_id);
    const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
    return { success: false, error };
  }
}

async function processKickoffSitemapJob(job: NuQJob<ScrapeJobKickoffSitemap>) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processKickoffSitemapJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data.crawl_id,
    zeroDataRetention: job.data.zeroDataRetention ?? false,
  });

  const sc = await getCrawl(job.data.crawl_id);

  try {
    if (!sc) {
      logger.error("Crawl not found");
      return { success: false, error: "Crawl not found" };
    }

    const crawler = crawlToCrawler(
      job.data.crawl_id,
      sc,
      (await getACUCTeam(job.data.team_id))?.flags ?? null,
    );

    const results = await scrapeSitemap({
      url: job.data.sitemapUrl,
      maxAge: 48 * 60 * 60 * 1000,
      zeroDataRetention: job.data.zeroDataRetention ?? false,
      location: job.data.location,
      crawlId: job.data.crawl_id,
      logger,
      isPreCrawl: sc.internalOptions?.isPreCrawl ?? false,
    });

    const passingURLs = (
      await crawler.filterLinks(
        results.urls.map(x => x.href),
        Infinity,
        sc.crawlerOptions.maxDepth ?? 10,
        false,
      )
    ).links;

    if (passingURLs.length > 0) {
      logger.debug("Using urls of length " + passingURLs.length, {
        urlsLength: passingURLs.length,
      });

      const jobPriority = await getJobPriority({
        team_id: job.data.team_id,
        basePriority: 21,
      });

      const jobs = passingURLs.map(url => ({
        data: {
          url: url,
          mode: "single_urls" as const,
          team_id: job.data.team_id,
          crawlerOptions: sc.crawlerOptions,
          scrapeOptions: sc.scrapeOptions,
          internalOptions: sc.internalOptions,
          origin: job.data.origin,
          integration: job.data.integration,
          crawl_id: job.data.crawl_id,
          requestId: job.data.requestId,
          sitemapped: true,
          webhook: job.data.webhook,
          v1: job.data.v1,
          zeroDataRetention:
            job.data.zeroDataRetention || (sc.zeroDataRetention ?? false),
          apiKeyId: job.data.apiKeyId,
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
  } catch (error) {
    logger.error("An error occurred!", { error });
    return { success: false, error };
  } finally {
    await redisEvictConnection.sadd(
      "crawl:" + job.data.crawl_id + ":sitemap_jobs_done",
      job.id,
    );
    await redisEvictConnection.expire(
      "crawl:" + job.data.crawl_id + ":sitemap_jobs_done",
      24 * 60 * 60,
    );
  }
}

export const processJobInternal = async (job: NuQJob<ScrapeJobData>) => {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJobInternal",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    zeroDataRetention: job.data?.zeroDataRetention ?? false,
  });

  // Restore trace context if available and execute within span
  if (job.data.traceContext) {
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
  } else {
    return processJobWithTracing(job, logger);
  }
};

async function processJobWithTracing(job: NuQJob<ScrapeJobData>, logger: any) {
  try {
    try {
      let extendLockInterval: NodeJS.Timeout | null = null;
      if (
        job.data?.mode !== "kickoff" &&
        job.data?.team_id &&
        !job.data.skipNuq
      ) {
        extendLockInterval = setInterval(async () => {
          await pushConcurrencyLimitActiveJob(
            job.data.team_id,
            job.id,
            60 * 1000,
          ); // 60s lock renew, just like in the queue
        }, jobLockExtendInterval);
      }

      await addJobPriority(job.data.team_id, job.id);
      try {
        if (job.data.mode === "kickoff") {
          const result = await processKickoffJob(
            job as NuQJob<ScrapeJobKickoff>,
          );
          if (result.success) {
            return null;
          } else {
            throw (result as any).error;
          }
        } else if (job.data.mode === "kickoff_sitemap") {
          const result = await processKickoffSitemapJob(
            job as NuQJob<ScrapeJobKickoffSitemap>,
          );
          if (result.success) {
            return null;
          } else {
            throw (result as any).error;
          }
        } else {
          const result = await processJob(job as NuQJob<ScrapeJobSingleUrls>);
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
            } catch (e) {
              logger.warn("Failed to set most recent success", { error: e });
            }

            try {
              if (config.GCS_BUCKET_NAME && !job.data.skipNuq) {
                logger.debug("Job succeeded -- putting null in Redis");
                return null;
              } else {
                logger.debug("Job succeeded -- putting result in Redis");
                return result.document;
              }
            } catch (e) {}
          } else {
            throw (result as any).error;
          }
        }
      } finally {
        await deleteJobPriority(job.data.team_id, job.id);
        if (extendLockInterval) {
          clearInterval(extendLockInterval);
        }
      }
    } finally {
      if (!job.data.skipNuq) {
        await concurrentJobDone(job);
      }
    }
  } catch (error) {
    logger.warn("Job failed", { error });

    // Filter out TransportableErrors (flow control)
    if (!(error instanceof TransportableError)) {
      captureExceptionWithZdrCheck(error, {
        extra: { zeroDataRetention: job.data.zeroDataRetention ?? false },
      });
    }

    if (job.data.skipNuq) {
      throw error;
    } else {
      if (error instanceof TransportableError) {
        throw new Error(serializeTransportableError(error));
      } else {
        throw new Error(serializeTransportableError(new UnknownError(error)));
      }
    }
  }
}

const exitHandler = () => {
  process.exit(0);
};

process.on("SIGINT", exitHandler);
process.on("SIGTERM", exitHandler);
process.on("exit", exitHandler);
