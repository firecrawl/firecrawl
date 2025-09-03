import { configDotenv } from "dotenv";
import { Job } from "bullmq";
import * as Sentry from "@sentry/node";
import http from "http";
import https from "https";

import { logger as _logger } from "../../lib/logger";
import {
  concurrentJobDone,
  pushConcurrencyLimitActiveJob,
} from "../../lib/concurrency-limit";
import { addJobPriority, deleteJobPriority } from "../../lib/job-priority";
import { cacheableLookup } from "../../scraper/scrapeURL/lib/cacheableLookup";
import { v4 as uuidv4 } from "uuid";
import {
  addCrawlJob,
  addCrawlJobs,
  addCrawlJobDone,
  crawlToCrawler,
  finishCrawlKickoff,
  generateURLPermutations,
  getCrawl,
  lockURL,
  lockURLsIndividually,
  normalizeURL,
  saveCrawl,
  StoredCrawl,
} from "../../lib/crawl-redis";
import { addScrapeJob, addScrapeJobs } from "../queue-jobs";
import { getJobPriority } from "../../lib/job-priority";
import { Document, scrapeOptions, TeamFlags } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";
import { getACUCTeam } from "../../controllers/auth";
import { callWebhook } from "../webhook";
import { CustomError } from "../../lib/custom-error";
import { startWebScraperPipeline } from "../../main/runWebScraper";
import { CostTracking } from "../../lib/cost-tracking";
import { redisEvictConnection } from "../redis";
import { normalizeUrlOnlyHostname } from "../../lib/canonical-url";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { logJob } from "../logging/log_job";
import { generateURLSplits, queryIndexAtSplitLevel } from "../index";
import { WebCrawler } from "../../scraper/WebScraper/crawler";
import { calculateCreditsToBeBilled } from "../../lib/scrape-billing";
import { getBillingQueue } from "../queue-service";
import type { Logger } from "winston";
import { finishCrawlIfNeeded } from "./crawl-logic";
import { LangfuseExporter } from "langfuse-vercel";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  RacedRedirectError,
  ScrapeJobTimeoutError,
  TransportableError,
  UnknownError,
} from "../../lib/error";
import { serializeTransportableError } from "../../lib/error-serde";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

configDotenv();

const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 10000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

cacheableLookup.install(http.globalAgent);
cacheableLookup.install(https.globalAgent);

async function billScrapeJob(
  job: Job & { id: string },
  document: Document | null,
  logger: Logger,
  costTracking: CostTracking,
  flags: TeamFlags,
) {
  let creditsToBeBilled: number | null = null;

  if (job.data.is_scrape !== true && !job.data.internalOptions?.bypassBilling) {
    creditsToBeBilled = await calculateCreditsToBeBilled(
      job.data.scrapeOptions,
      job.data.internalOptions,
      document,
      costTracking,
      flags,
    );

    if (
      job.data.team_id !== process.env.BACKGROUND_INDEX_TEAM_ID! &&
      process.env.USE_DB_AUTHENTICATION === "true"
    ) {
      try {
        const billingJobId = uuidv4();
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
        Sentry.captureException(error);
        return creditsToBeBilled;
      }
    }
  }

  return creditsToBeBilled;
}

async function processJob(job: Job & { id: string }) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
    zeroDataRetention: job.data?.zeroDataRetention ?? false,
  });
  logger.info(`🐂 Worker taking job ${job.id}`, { url: job.data.url });
  const start = job.data.startTime ?? Date.now();
  const remainingTime = job.data.scrapeOptions.timeout
    ? job.data.scrapeOptions.timeout - (Date.now() - start)
    : undefined;

  const costTracking = new CostTracking();

  try {
    job.updateProgress({
      current: 1,
      total: 100,
      current_step: "SCRAPING",
      current_url: "",
    });

    if (remainingTime !== undefined && remainingTime < 0) {
      throw new ScrapeJobTimeoutError("Scrape timed out");
    }
    const signal = remainingTime
      ? AbortSignal.timeout(remainingTime)
      : undefined;

    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
      if (sc && sc.cancelled) {
        throw new Error("Parent crawl/batch scrape was cancelled");
      }
    }

    const pipeline = await Promise.race([
      startWebScraperPipeline({
        job,
        costTracking,
      }),
      ...(remainingTime !== undefined
        ? [
            (async () => {
              await sleep(remainingTime);
              throw new ScrapeJobTimeoutError("Scrape timed out");
            })(),
          ]
        : []),
    ]);

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
      project_id: job.data.project_id,
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
        const filterResult = crawler.filterURL(
          doc.metadata.url,
          doc.metadata.sourceURL,
        );
        if (!filterResult.allowed && !job.data.isCrawlSourceScrape) {
          const reason =
            filterResult.denialReason ||
            "Redirected target URL is not allowed by crawlOptions";
          throw new Error(reason);
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
          throw new Error(BLOCKLISTED_URL_MESSAGE); // TODO: make this its own error type that is ignored by error tracking
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

          for (const link of links.links) {
            if (await lockURL(job.data.crawl_id, sc, link)) {
              // This seems to work really welel
              const jobPriority = await getJobPriority({
                team_id: sc.team_id,
                basePriority: job.data.crawl_id ? 20 : 10,
              });
              const jobId = uuidv4();

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
                  webhook: job.data.webhook,
                  v1: job.data.v1,
                  zeroDataRetention: job.data.zeroDataRetention,
                  apiKeyId: job.data.apiKeyId,
                },
                {},
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
              throw new Error(reason);
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
      );

      doc.metadata.creditsUsed = credits_billed ?? undefined;

      logger.debug("Logging job to DB...");
      await logJob(
        {
          job_id: job.id as string,
          success: true,
          num_docs: 1,
          docs: [doc],
          time_taken: timeTakenInSeconds,
          team_id: job.data.team_id,
          mode: job.data.mode,
          url: job.data.url,
          crawlerOptions: sc.crawlerOptions,
          scrapeOptions: job.data.scrapeOptions,
          origin: job.data.origin,
          integration: job.data.integration,
          crawl_id: job.data.crawl_id,
          cost_tracking: costTracking,
          pdf_num_pages: doc.metadata.numPages,
          credits_billed,
          change_tracking_tag:
            hasFormatOfType(job.data.scrapeOptions.formats, "changeTracking")
              ?.tag ?? null,
          zeroDataRetention: job.data.zeroDataRetention,
        },
        true,
        job.data.internalOptions?.bypassBilling ?? false,
      );

      if (job.data.webhook && job.data.mode !== "crawl" && job.data.v1) {
        logger.debug("Calling webhook with success...", {
          webhook: job.data.webhook,
        });
        callWebhook({
          teamId: job.data.team_id,
          crawlId: job.data.crawl_id,
          scrapeId: job.id,
          data,
          webhook: job.data.webhook,
          v1: job.data.v1,
          eventType:
            job.data.crawlerOptions !== null
              ? "crawl.page"
              : "batch_scrape.page",
        });
      }

      logger.debug("Declaring job as done...");
      await addCrawlJobDone(job.data.crawl_id, job.id, true, logger);

      await finishCrawlIfNeeded(job, sc);
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
      );

      doc.metadata.creditsUsed = credits_billed ?? undefined;

      await logJob(
        {
          job_id: job.id,
          success: true,
          message: "Scrape completed",
          num_docs: 1,
          docs: [doc],
          time_taken: timeTakenInSeconds,
          team_id: job.data.team_id,
          mode: "scrape",
          url: job.data.url,
          scrapeOptions: job.data.scrapeOptions,
          origin: job.data.origin,
          integration: job.data.integration,
          num_tokens: 0, // TODO: fix
          cost_tracking: costTracking,
          pdf_num_pages: doc.metadata.numPages,
          credits_billed,
          change_tracking_tag:
            hasFormatOfType(job.data.scrapeOptions.formats, "changeTracking")
              ?.tag ?? null,
          zeroDataRetention: job.data.zeroDataRetention,
        },
        false,
        job.data.internalOptions?.bypassBilling ?? false,
      );
    }

    logger.info(`🐂 Job done ${job.id}`);
    return data;
  } catch (error) {
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

      await finishCrawlIfNeeded(job, sc);
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

      Sentry.captureException(error, {
        data: {
          job: job.id,
        },
      });

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
      project_id: job.data.project_id,
      error:
        error instanceof Error
          ? error
          : typeof error === "string"
            ? new Error(error)
            : new Error(JSON.stringify(error)),
    };

    if (!job.data.v1 && (job.data.mode === "crawl" || job.data.crawl_id)) {
      callWebhook({
        teamId: job.data.team_id,
        crawlId: job.data.crawl_id ?? (job.id as string),
        scrapeId: job.id,
        data,
        webhook: job.data.webhook,
        v1: job.data.v1,
        eventType:
          job.data.crawlerOptions !== null ? "crawl.page" : "batch_scrape.page",
      });
    }

    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    const credits_billed = await billScrapeJob(
      job,
      null,
      logger,
      costTracking,
      (await getACUCTeam(job.data.team_id))?.flags ?? null,
    );

    logger.debug("Logging job to DB...");
    await logJob(
      {
        job_id: job.id as string,
        success: false,
        message:
          typeof error === "string"
            ? error
            : (error.message ??
              "Something went wrong... Contact help@mendable.ai"),
        num_docs: 0,
        docs: [],
        time_taken: timeTakenInSeconds,
        team_id: job.data.team_id,
        mode: job.data.mode,
        url: job.data.url,
        crawlerOptions: job.data.crawlerOptions,
        scrapeOptions: job.data.scrapeOptions,
        origin: job.data.origin,
        integration: job.data.integration,
        crawl_id: job.data.crawl_id,
        cost_tracking: costTracking,
        credits_billed,
        zeroDataRetention: job.data.zeroDataRetention,
      },
      true,
      job.data.internalOptions?.bypassBilling ?? false,
    );
    return data;
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
    index.filter(x => crawler.filterURL(x, trimmedURL.href).allowed),
    sc.crawlerOptions.limit ?? 10000,
    sc.crawlerOptions.maxDepth ?? 10,
    false,
  );
  const validIndexLinks = validIndexLinksResult.links;

  return validIndexLinks;
}

async function processKickoffJob(job: Job & { id: string }) {
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
    const jobId = uuidv4();
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
        webhook: job.data.webhook,
        v1: job.data.v1,
        isCrawlSourceScrape: true,
        zeroDataRetention: job.data.zeroDataRetention,
        apiKeyId: job.data.apiKeyId,
      },
      {
        priority: 15,
      },
      jobId,
    );
    logger.debug("Adding scrape job to BullMQ...", { jobId });
    await addCrawlJob(job.data.crawl_id, jobId, logger);

    if (job.data.webhook) {
      logger.debug("Calling webhook with crawl.started...", {
        webhook: job.data.webhook,
      });
      callWebhook({
        teamId: job.data.team_id,
        crawlId: job.data.crawl_id,
        data: null,
        webhook: job.data.webhook,
        v1: job.data.v1,
        eventType: "crawl.started",
      });
    }

    const sitemap = sc.crawlerOptions.ignoreSitemap
      ? 0
      : await crawler.tryGetSitemap(async urls => {
          if (urls.length === 0) return;

          logger.debug("Using sitemap chunk of length " + urls.length, {
            sitemapLength: urls.length,
          });

          let jobPriority = await getJobPriority({
            team_id: job.data.team_id,
            basePriority: 21,
          });
          logger.debug("Using job priority " + jobPriority, { jobPriority });

          const jobs = urls.map(url => {
            const uuid = uuidv4();
            return {
              name: uuid,
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
                sitemapped: true,
                webhook: job.data.webhook,
                v1: job.data.v1,
                zeroDataRetention: job.data.zeroDataRetention,
                apiKeyId: job.data.apiKeyId,
              },
              opts: {
                jobId: uuid,
                priority: 20,
              },
            };
          });

          logger.debug("Locking URLs...");
          const lockedIds = await lockURLsIndividually(
            job.data.crawl_id,
            sc,
            jobs.map(x => ({ id: x.opts.jobId, url: x.data.url })),
          );
          const lockedJobs = jobs.filter(x =>
            lockedIds.find(y => y.id === x.opts.jobId),
          );
          logger.debug("Adding scrape jobs to Redis...");
          await addCrawlJobs(
            job.data.crawl_id,
            lockedJobs.map(x => x.opts.jobId),
            logger,
          );
          logger.debug("Adding scrape jobs to BullMQ...");
          await addScrapeJobs(lockedJobs);
        });

    if (sitemap === 0) {
      logger.debug("Sitemap not found or ignored.", {
        ignoreSitemap: sc.crawlerOptions.ignoreSitemap,
      });
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
        const uuid = uuidv4();
        return {
          name: uuid,
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
            sitemapped: true,
            webhook: job.data.webhook,
            v1: job.data.v1,
            zeroDataRetention: job.data.zeroDataRetention,
            apiKeyId: job.data.apiKeyId,
          },
          opts: {
            jobId: uuid,
            priority: 20,
          },
        };
      });

      logger.debug("Locking URLs...");
      const lockedIds = await lockURLsIndividually(
        job.data.crawl_id,
        sc,
        jobs.map(x => ({ id: x.opts.jobId, url: x.data.url })),
      );
      const lockedJobs = jobs.filter(x =>
        lockedIds.find(y => y.id === x.opts.jobId),
      );
      logger.debug("Adding scrape jobs to Redis...");
      await addCrawlJobs(
        job.data.crawl_id,
        lockedJobs.map(x => x.opts.jobId),
        logger,
      );
      logger.debug("Adding scrape jobs to BullMQ...");
      await addScrapeJobs(lockedJobs);
    }

    logger.debug("Done queueing jobs!");

    await finishCrawlKickoff(job.data.crawl_id);
    await finishCrawlIfNeeded(job, sc);

    return { success: true };
  } catch (error) {
    logger.error("An error occurred!", { error });
    await finishCrawlKickoff(job.data.crawl_id);
    const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
    if (sc) {
      await finishCrawlIfNeeded(job, sc);
    }
    return { success: false, error };
  }
}

export const processJobInternal = async (job: Job & { id: string }) => {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJobInternal",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    zeroDataRetention: job.data?.zeroDataRetention ?? false,
  });

  try {
    try {
      let extendLockInterval: NodeJS.Timeout | null = null;
      if (job.data?.mode !== "kickoff" && job.data?.team_id) {
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
        if (job.data?.mode === "kickoff") {
          const result = await processKickoffJob(job);
          if (result.success) {
            return null;
          } else {
            throw (result as any).error;
          }
        } else {
          const result = await processJob(job);
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
              if (
                process.env.USE_DB_AUTHENTICATION === "true" &&
                (job.data.crawl_id || process.env.GCS_BUCKET_NAME)
              ) {
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
      await concurrentJobDone(job);
    }
  } catch (error) {
    logger.debug("Job failed", { error });
    Sentry.captureException(error);
    if (error instanceof TransportableError) {
      throw new Error(serializeTransportableError(error));
    } else {
      throw new Error(serializeTransportableError(new UnknownError(error)));
    }
  }
};

const shouldOtel =
  process.env.LANGFUSE_PUBLIC_KEY || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const otelSdk = shouldOtel
  ? new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: "firecrawl-worker-scrape",
      }),
      spanProcessors: [
        ...(process.env.LANGFUSE_PUBLIC_KEY
          ? [new BatchSpanProcessor(new LangfuseExporter())]
          : []),
        ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
          ? [
              new BatchSpanProcessor(
                new OTLPTraceExporter({
                  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
                }),
              ),
            ]
          : []),
      ],
      instrumentations: [getNodeAutoInstrumentations()],
    })
  : null;

if (otelSdk) {
  otelSdk.start();
}

module.exports = processJobInternal;

const exitHandler = () => {
  if (otelSdk) {
    otelSdk.shutdown().then(() => {
      _logger.debug("OTEL shutdown");
      process.exit(0);
    });
  }
};

process.on("SIGINT", exitHandler);
process.on("SIGTERM", exitHandler);
process.on("exit", exitHandler);
