import "dotenv/config";
import "../sentry";
import * as Sentry from "@sentry/node";
import { Job, Queue, Worker } from "bullmq";
import { logger as _logger, logger } from "../../lib/logger";
import {
  getRedisConnection,
  getBillingQueue,
  getPrecrawlQueue,
  precrawlQueueName,
} from "../queue-service";
import {
  processBillingBatch,
  queueBillingOperation,
  startBillingBatchProcessing,
} from "../billing/batch_billing";
import systemMonitor from "../system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  index_supabase_service,
  processIndexInsertJobs,
  processIndexRFInsertJobs,
  processOMCEJobs,
  processDomainFrequencyJobs,
  queryDomainsForPrecrawl,
} from "..";
import { getSearchIndexClient } from "../../lib/search-index-client";
// Search indexing is now handled by the separate search service
// import { processSearchIndexJobs } from "../../lib/search-index/queue";
import { processWebhookInsertJobs } from "../webhook";
import {
  scrapeOptions as scrapeOptionsSchema,
  crawlRequestSchema,
  toV0CrawlerOptions,
} from "../../controllers/v2/types";
import { StoredCrawl, crawlToCrawler, saveCrawl } from "../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../queue-jobs";
import { BullMQOtel } from "bullmq-otel";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";

const workerLockDuration = Number(process.env.WORKER_LOCK_DURATION) || 60000;
const workerStalledCheckInterval =
  Number(process.env.WORKER_STALLED_CHECK_INTERVAL) || 30000;
const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

const runningJobs: Set<string> = new Set();

// Create a processor for billing jobs
const processBillingJobInternal = async (token: string, job: Job) => {
  if (!job.id) {
    throw new Error("Job has no ID");
  }

  const logger = _logger.child({
    module: "billing-worker",
    method: "processBillingJobInternal",
    jobId: job.id,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on billing job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  let err = null;
  try {
    // Check job type - it could be either a batch processing trigger or an individual billing operation
    if (job.name === "process-batch") {
      // Process the entire batch
      logger.info("Received batch process trigger job");
      await processBillingBatch();
    } else if (job.name === "bill_team") {
      // This is an individual billing operation that should be queued for batch processing
      const { team_id, subscription_id, credits, is_extract, api_key_id } =
        job.data;

      logger.info(`Adding team ${team_id} billing operation to batch queue`, {
        credits,
        is_extract,
        originating_job_id: job.data.originating_job_id,
      });

      // Add to the REDIS batch queue
      await queueBillingOperation(
        team_id,
        subscription_id,
        credits,
        api_key_id ?? null,
        is_extract,
      );
    } else {
      logger.warn(`Unknown billing job type: ${job.name}`);
    }

    await job.moveToCompleted({ success: true }, token, false);
  } catch (error) {
    logger.error("Error processing billing job", { error });
    Sentry.captureException(error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }

  return err;
};

// NOTE: current config is 100 domains with 250 urls per domain with estimated max budget of 10,000
const processPrecrawlJob = async (token: string, job: Job) => {
  const logger = _logger.child({
    module: "precrawl-worker",
    method: "processPrecrawlJob",
  });

  logger.info("Received index pre-crawl trigger job");

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on precrawl job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  // set to true to prevent crawl job submissions
  const DRY_RUN = false;

  // set to true to only run domain precrawl, no individual URLs or crawl jobs
  const DOMAIN_ONLY_RUN = false;

  const MAX_PRE_CRAWL_BUDGET = 10000; // maximum number of pages to precrawl this job

  const MAX_PRE_CRAWL_DOMAINS = 100; // maximum number of domains to precrawl
  const MIN_DOMAIN_PRIORITY = 2.0; // minimum priority score to consider a domain
  const MIN_DOMAIN_EVENTS = 1000; // minimum number of events to consider a domain

  // number of domain hashes to query in parallel - keep relatively low for now (25 is good)
  const DOMAIN_URL_BATCH_SIZE = 25;

  const MIN_URLS_PER_DOMAIN = 10;
  const MAX_URLS_PER_DOMAIN = 250;

  const teamId = process.env.PRECRAWL_TEAM_ID;

  try {
    await withSpan("precrawl.job", async span => {
      setSpanAttributes(span, {
        "precrawl.id": job.id,
        "precrawl.team_id": teamId,
        "precrawl.dry_run": DRY_RUN,
        "precrawl.config.budget": MAX_PRE_CRAWL_BUDGET,
        "precrawl.config.max_domains": MAX_PRE_CRAWL_DOMAINS,
        "precrawl.config.min_priority": MIN_DOMAIN_PRIORITY,
        "precrawl.config.min_events": MIN_DOMAIN_EVENTS,
        "precrawl.config.url_batch_size": DOMAIN_URL_BATCH_SIZE,
        "precrawl.config.urls_per_domain": MIN_URLS_PER_DOMAIN,
      });

      const dateFuture = new Date();
      dateFuture.setHours(dateFuture.getHours() + 1);

      const domains = await queryDomainsForPrecrawl(
        dateFuture,
        MIN_DOMAIN_EVENTS,
        MIN_DOMAIN_PRIORITY,
        MAX_PRE_CRAWL_DOMAINS,
        logger,
      ).then(domains => {
        return domains
          .map(d => ({
            ...d,
            priority: Math.sqrt(d.priority),
          }))
          .sort((a, b) => b.priority - a.priority);
      });

      if (domains.length === 0) {
        logger.info("No domains due for precrawl, skipping job");
        await job.moveToCompleted({ success: true }, token, false);
        return;
      }

      setSpanAttributes(span, {
        "precrawl.domain_count": domains.length,
      });

      logger.info(`Found ${domains.length} domains for precrawl test`);

      const minPriority = Math.min(...domains.map(d => d.priority));
      const maxPriority = Math.max(...domains.map(d => d.priority));

      logger.debug(
        `Domain priority range: ${minPriority.toFixed(
          2,
        )} - ${maxPriority.toFixed(2)}`,
      );

      // TODO: tweak total budget calculation
      const totalBudget = (() => {
        const n = domains.length;
        if (n <= 25)
          return Math.min(MAX_PRE_CRAWL_BUDGET, 3000 + (n - 1) * 500);
        if (n <= 100)
          return Math.min(MAX_PRE_CRAWL_BUDGET, 10000 + (n - 5) * 200);
        return MAX_PRE_CRAWL_BUDGET;
      })();

      const totalPriority = Math.max(
        domains.reduce((sum, x) => Number(sum) + Number(x.priority), 0),
        1,
      );

      const domainQueries = domains.map(d => {
        const normalizedPriority =
          maxPriority === minPriority
            ? 0
            : (d.priority - minPriority) / (maxPriority - minPriority);

        const urlsToFetch = Math.round(
          MIN_URLS_PER_DOMAIN +
            normalizedPriority * (MAX_URLS_PER_DOMAIN - MIN_URLS_PER_DOMAIN),
        );

        return {
          hash: d.domain_hash,
          priority: d.priority,
          urlsToFetch,
        };
      });

      if (DOMAIN_ONLY_RUN) {
        logger.debug(`------------------------------`);
        logger.debug(`DOMAIN ONLY RUN - no crawl jobs submitted`);
        logger.debug(
          `Total budget: ${totalBudget} for ${domains.length} domains`,
        );
        logger.debug(`------------------------------`);
        logger.debug(
          `Precrawl domains: (${domainQueries.length}) ${JSON.stringify(domainQueries.slice(0, 5), null, 2)} ...`,
        );
        await job.moveToCompleted({ success: true }, token, false);
        return;
      }

      const batches: (typeof domainQueries)[] = [];
      for (let i = 0; i < domainQueries.length; i += DOMAIN_URL_BATCH_SIZE) {
        batches.push(domainQueries.slice(i, i + DOMAIN_URL_BATCH_SIZE));
      }

      type DomainUrlResult = {
        url: string;
        domain_hash: string;
        event_count: number;
        rank: number;
      };

      const urlResults: PromiseSettledResult<{
        data: DomainUrlResult[] | null;
        error: any;
      }>[] = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        const batchFutures = batch.map(({ hash, urlsToFetch }) => {
          return index_supabase_service
            .rpc("query_top_urls_for_domain", {
              p_domain_hash: hash,
              p_time_window: "8 days", // increasing window can significantly slow down the query, modify with caution
              p_top_n: urlsToFetch,
            })
            .overrideTypes<DomainUrlResult[]>();
        });

        const startTimeNs = process.hrtime.bigint();
        const batchResults = (await Promise.allSettled(
          batchFutures,
        )) as PromiseSettledResult<{
          data: DomainUrlResult[] | null;
          error: any;
        }>[];
        const endTimeNs = process.hrtime.bigint();

        urlResults.push(...batchResults);

        if (i < batches.length - 1) {
          const durationMs = Number(endTimeNs - startTimeNs) / 1e6;
          const backoff = Math.min(1000 + i * 100, 3000);
          logger.debug(
            `Completed batch ${i + 1}/${batches.length} of URL fetches (failed: ${batchResults.filter(r => r.status === "rejected" || (r.status === "fulfilled" && r.value.error)).length}) in ${durationMs}ms. Waiting for ${backoff}ms before next batch...`,
          );
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }

      let failedBatches = 0;
      const urls: DomainUrlResult[] = [];
      for (const r of urlResults) {
        if (r.status === "fulfilled") {
          if (r.value.error) {
            if (r.value.error.code !== "57014") {
              // query cancelled (likely timeout, need to monitor this)
              logger.error("Pre-crawl RPC error", { error: r.value.error });
            }
            failedBatches++;
            continue;
          }

          urls.push(...(r.value.data as DomainUrlResult[]));
        } else {
          logger.error("Pre-crawl RPC failed", { error: r.reason });
          failedBatches++;
        }
      }

      if (urls.length === 0) {
        logger.warn("No URLs found for precrawl, skipping job");
        await job.moveToCompleted({ success: true }, token, false);
        return;
      }

      setSpanAttributes(span, {
        "precrawl.url_count": urls.length,
        "precrawl.total_batches": urlResults.length,
        "precrawl.failed_batches": failedBatches,
      });

      logger.info(
        `Found ${urls.length} URLs for precrawl (${urlResults.length - failedBatches}/${failedBatches})`,
      );

      const bucketedByDomain: Map<string, DomainUrlResult[]> = new Map();
      for (const item of urls) {
        if (!bucketedByDomain.has(item.domain_hash)) {
          bucketedByDomain.set(item.domain_hash, []);
        }
        bucketedByDomain.get(item.domain_hash)!.push(item);
      }

      const crawlTargets: Map<
        string,
        {
          url: string;
          budget: number;
          domainBudget: number;
          eventCount: number;
        }
      > = new Map();

      let noPageDomains = 0;

      for (const domain of domains) {
        try {
          const pages = bucketedByDomain.get(domain.domain_hash);

          // if this doesn't have any pages, do we want to locate the domain itself and add root only?
          if (!pages || pages.length === 0) {
            noPageDomains++;
            continue;
          }

          const totalEvents = Math.max(
            pages.reduce((sum: number, s) => sum + s.event_count, 0),
            1,
          );

          const filteredPages = pages.map(s => ({
            domain: new URL(s.url).hostname,
            url: s.url,
            event_count: s.event_count,
            rank: s.rank,
          }));

          const domainBudget = (domain.priority / totalPriority) * totalBudget;

          for (const page of filteredPages) {
            const pageBudget = Math.round(
              (page.event_count / totalEvents) * domainBudget,
            );

            const rootUrl = `https://${page.domain}/`;
            if (!crawlTargets.get(rootUrl)) {
              crawlTargets.set(rootUrl, {
                url: rootUrl,
                budget: pageBudget,
                domainBudget,
                eventCount: -1,
              });
            }

            // should be able to ignore sitemap, it will be fetched by the root crawl
            if (page.url && !page.url.endsWith("/sitemap.xml")) {
              const existingEntry = crawlTargets.get(page.url);
              if (existingEntry) {
                if (existingEntry.eventCount < 0) {
                  existingEntry.eventCount = page.event_count;
                } else {
                  existingEntry.eventCount += page.event_count;
                }

                existingEntry.budget += pageBudget;
                existingEntry.domainBudget += domainBudget;
                crawlTargets.set(page.url, existingEntry);
                continue;
              }

              crawlTargets.set(page.url, {
                url: page.url,
                budget: pageBudget,
                domainBudget,
                eventCount: page.event_count,
              });
            }
          }
        } catch (e) {
          logger.error("Error processing domain in precrawl job", {
            error: e,
            domain: domain.domain_hash,
          });
        }
      }

      if (noPageDomains > 0) {
        logger.debug(
          `Skipping ${noPageDomains} domains with no pages found (${noPageDomains} of ${domains.length})`,
        );
      }

      setSpanAttributes(span, {
        "precrawl.targets": crawlTargets.size,
      });

      if (!DRY_RUN && teamId && crawlTargets.size > 0) {
        logger.info(
          `Pre-crawling ${crawlTargets.size} urls using total budget: ${totalBudget}`,
        );

        let submittedCrawls = 0;

        for (const target of crawlTargets.values()) {
          try {
            const { url, budget: limit } = target;

            const crawlerOptions = {
              ...crawlRequestSchema.parse({ url, limit }),
              url: undefined, // unsure why this is needed but leaving for now
              scrapeOptions: undefined, // same here
            };

            const scrapeOptions = scrapeOptionsSchema.parse({});
            const sc: StoredCrawl = {
              originUrl: url,
              crawlerOptions: toV0CrawlerOptions(crawlerOptions),
              scrapeOptions,
              internalOptions: {
                disableSmartWaitCache: true, // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
                teamId,
                saveScrapeResultToGCS:
                  !!process.env.GCS_FIRE_ENGINE_BUCKET_NAME,
                zeroDataRetention: true, // is this meant to be true?
                isPreCrawl: true, // NOTE: must be added to internal options for indexing, if not it will be treated as a normal scrape in the index
              },
              team_id: teamId,
              createdAt: Date.now(),
              maxConcurrency: undefined,
              zeroDataRetention: false,
            };

            const crawlId = uuidv4();

            // robots disabled for now
            // const crawler = crawlToCrawler(crawlId, sc, null);
            // try {
            //   sc.robots = await crawler.getRobotsTxt(
            //     scrapeOptions.skipTlsVerification,
            //   );
            //   const robotsCrawlDelay = crawler.getRobotsCrawlDelay();
            //   if (robotsCrawlDelay !== null && !sc.crawlerOptions.delay) {
            //     sc.crawlerOptions.delay = robotsCrawlDelay;
            //   }
            // } catch (e) {
            //   logger.debug("Failed to get robots.txt (this is probably fine!)", {
            //     error: e,
            //   });
            // }

            await saveCrawl(crawlId, sc);

            await _addScrapeJobToBullMQ(
              {
                url: url,
                mode: "kickoff" as const,
                team_id: teamId,
                crawlerOptions,
                scrapeOptions: sc.scrapeOptions,
                internalOptions: sc.internalOptions,
                origin: "precrawl",
                integration: null,
                crawl_id: crawlId,
                webhook: undefined,
                v1: true,
                zeroDataRetention: false,
                apiKeyId: null,
              },
              crypto.randomUUID(),
            );

            submittedCrawls++;
          } catch (e) {
            logger.error("Error adding precrawl job to queue", { error: e });
            Sentry.captureException(e);
          }
        }

        if (submittedCrawls !== crawlTargets.size) {
          logger.info(
            `Submitted ${submittedCrawls} crawls, but had ${crawlTargets.size} targets`,
          );
        } else {
          logger.info(`Submitted ${submittedCrawls} crawls`);
        }
      } else {
        logger.debug("------------------------------");
        logger.debug(`DRY RUN - no crawl jobs submitted: ${crawlTargets.size}`);
        logger.debug(
          `Calculated pre-crawl targets: (${crawlTargets.size}) ${JSON.stringify(Array.from(crawlTargets.values()).slice(0, 2), null, 2)} ...`,
        );
        logger.debug(`Total budget: ${totalBudget}`);
        logger.debug("------------------------------");
      }

      await job.moveToCompleted({ success: true }, token, false);
    });
  } catch (e) {
    logger.error("Error processing precrawl job", { error: e });
    Sentry.captureException(e);
    await job.moveToFailed(e, token, false);
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  logger.info("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

// Generic worker function that can process different job types
const workerFun = async (
  queue: Queue,
  jobProcessor: (token: string, job: Job) => Promise<any>,
) => {
  const logger = _logger.child({ module: "index-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: getRedisConnection(),
    lockDuration: workerLockDuration,
    stalledInterval: workerStalledCheckInterval,
    maxStalledCount: queue.name === precrawlQueueName ? 0 : 10,
    telemetry: new BullMQOtel("firecrawl-bullmq"),
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;

  while (true) {
    if (isShuttingDown) {
      logger.info("No longer accepting new jobs. SIGINT");
      break;
    }

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();

    if (!canAcceptConnection) {
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      if (cantAcceptConnectionCount >= 25) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
      }

      await new Promise(resolve =>
        setTimeout(resolve, cantAcceptConnectionInterval),
      );
      continue;
    } else {
      cantAcceptConnectionCount = 0;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      if (job.id) {
        runningJobs.add(job.id);
      }

      await jobProcessor(token, job);

      if (job.id) {
        runningJobs.delete(job.id);
      }

      await new Promise(resolve => setTimeout(resolve, gotJobInterval));
    } else {
      await new Promise(resolve =>
        setTimeout(resolve, connectionMonitorInterval),
      );
    }
  }

  logger.info("Worker loop ended. Waiting for running jobs to finish...");
  while (runningJobs.size > 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  logger.info("All jobs finished. Worker exiting!");
  process.exit(0);
};

const INDEX_INSERT_INTERVAL = 3000;
const WEBHOOK_INSERT_INTERVAL = 15000;
const OMCE_INSERT_INTERVAL = 5000;
const DOMAIN_FREQUENCY_INTERVAL = 10000;
// Search indexing is now handled by separate search service, not this worker
// const SEARCH_INDEX_INTERVAL = 10000;

// Start the workers
(async () => {
  // Start billing worker and batch processing
  startBillingBatchProcessing();
  const billingWorkerPromise = workerFun(
    getBillingQueue(),
    processBillingJobInternal,
  );

  const precrawlWorkerPromise = process.env.PRECRAWL_TEAM_ID
    ? workerFun(getPrecrawlQueue(), processPrecrawlJob)
    : (async () => {
        logger.warn("PRECRAWL_TEAM_ID not set, skipping precrawl worker");
      })();

  const indexInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }

    await withSpan("firecrawl-index-worker-process-insert-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_insert_jobs",
        "index.worker.type": "scheduled",
      });
      await processIndexInsertJobs();
    });
  }, INDEX_INSERT_INTERVAL);

  const webhookInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await processWebhookInsertJobs();
  }, WEBHOOK_INSERT_INTERVAL);

  const indexRFInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan(
      "firecrawl-index-worker-process-rf-insert-jobs",
      async span => {
        setSpanAttributes(span, {
          "index.worker.operation": "process_rf_insert_jobs",
          "index.worker.type": "scheduled",
        });
        await processIndexRFInsertJobs();
      },
    );
  }, INDEX_INSERT_INTERVAL);

  const omceInserterInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan("firecrawl-index-worker-process-omce-jobs", async span => {
      setSpanAttributes(span, {
        "index.worker.operation": "process_omce_jobs",
        "index.worker.type": "scheduled",
      });
      await processOMCEJobs();
    });
  }, OMCE_INSERT_INTERVAL);

  const domainFrequencyInterval = setInterval(async () => {
    if (isShuttingDown) {
      return;
    }
    await withSpan(
      "firecrawl-index-worker-process-domain-frequency-jobs",
      async span => {
        setSpanAttributes(span, {
          "index.worker.operation": "process_domain_frequency_jobs",
          "index.worker.type": "scheduled",
        });
        await processDomainFrequencyJobs();
      },
    );
  }, DOMAIN_FREQUENCY_INTERVAL);

  // Search indexing is now handled by separate search service
  // The search service has its own worker that processes the queue
  // This worker no longer needs to process search index jobs

  // Health check for search service (optional)
  const searchClient = getSearchIndexClient();
  if (searchClient) {
    searchClient
      .health()
      .then(healthy => {
        if (healthy) {
          logger.info("Search service is healthy");
        } else {
          logger.warn("Search service health check failed");
        }
      })
      .catch(error => {
        logger.error("Search service health check error", { error });
      });
  }

  // Wait for all workers to complete (which should only happen on shutdown)
  await Promise.all([billingWorkerPromise, precrawlWorkerPromise]);

  clearInterval(indexInserterInterval);
  clearInterval(webhookInserterInterval);
  clearInterval(indexRFInserterInterval);
  clearInterval(omceInserterInterval);
  clearInterval(domainFrequencyInterval);

  logger.info("All workers shut down, exiting process");
})();
