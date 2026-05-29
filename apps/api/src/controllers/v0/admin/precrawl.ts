import type { Request, Response } from "express";
import { config } from "../../../config";
import { logger as _logger } from "../../../lib/logger";
import * as Sentry from "@sentry/node";
import { v7 as uuidv7 } from "uuid";
import {
  index_supabase_service,
  queryDomainsForPrecrawl,
} from "../../../services";
import {
  scrapeOptions as scrapeOptionsSchema,
  crawlRequestSchema,
  toV0CrawlerOptions,
} from "../../../controllers/v2/types";
import { StoredCrawl, saveCrawl } from "../../../lib/crawl-redis";
import { _addScrapeJobToBullMQ } from "../../../services/queue-jobs";
import { withSpan, setSpanAttributes } from "../../../lib/otel-tracer";
import { crawlGroup } from "../../../services/worker/nuq";
import { getACUCTeam } from "../../../controllers/auth";
import { logRequest } from "../../../services/logging/log_job";

const DRY_RUN = false;
const DOMAIN_ONLY_RUN = false;

const MAX_PRE_CRAWL_BUDGET = 25000;
const MAX_PRE_CRAWL_DOMAINS = 500;
const MIN_DOMAIN_PRIORITY = 4.0;
const MIN_DOMAIN_EVENTS = 1000;
const DOMAIN_URL_BATCH_SIZE = 25;
const MIN_URLS_PER_DOMAIN = 10;
const MAX_URLS_PER_DOMAIN = 50;

export async function triggerPrecrawl(_: Request, res: Response) {
  const teamId = config.PRECRAWL_TEAM_ID;
  if (!teamId) {
    res.status(400).json({ ok: false, error: "PRECRAWL_TEAM_ID not set" });
    return;
  }

  // Respond immediately — the precrawl runs in the background
  res.json({ ok: true });

  const logger = _logger.child({
    module: "precrawl",
    method: "triggerPrecrawl",
  });

  logger.info("Precrawl triggered via admin endpoint");

  try {
    await runPrecrawl(teamId, logger);
  } catch (e) {
    logger.error("Error running precrawl", { error: e });
    Sentry.captureException(e);
  }
}

type DomainUrlResult = {
  url: string;
  domain_hash: string;
  event_count: number;
  rank: number;
};

async function runPrecrawl(teamId: string, logger: typeof _logger) {
  await withSpan("precrawl.job", async span => {
    setSpanAttributes(span, {
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
      logger.info("No domains due for precrawl, skipping");
      return;
    }

    setSpanAttributes(span, {
      "precrawl.domain_count": domains.length,
    });

    logger.info(`Found ${domains.length} domains for precrawl`);

    const minPriority = Math.min(...domains.map(d => d.priority));
    const maxPriority = Math.max(...domains.map(d => d.priority));

    logger.debug(
      `Domain priority range: ${minPriority.toFixed(2)} - ${maxPriority.toFixed(2)}`,
    );

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
      return;
    }

    const batches: (typeof domainQueries)[] = [];
    for (let i = 0; i < domainQueries.length; i += DOMAIN_URL_BATCH_SIZE) {
      batches.push(domainQueries.slice(i, i + DOMAIN_URL_BATCH_SIZE));
    }

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
            p_time_window: "8 days",
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
      logger.warn("No URLs found for precrawl, skipping");
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
        logger.error("Error processing domain in precrawl", {
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

    if (!DRY_RUN && crawlTargets.size > 0) {
      logger.info(
        `Pre-crawling ${crawlTargets.size} urls using total budget: ${totalBudget}`,
      );

      let submittedCrawls = 0;

      for (const target of crawlTargets.values()) {
        try {
          const { url, budget: limit } = target;

          const crawlId = uuidv7();
          await logRequest({
            id: crawlId,
            kind: "crawl",
            api_version: "v2",
            team_id: teamId,
            origin: "precrawl",
            target_hint: url,
            zeroDataRetention: false,
            api_key_id: null,
          });

          const crawlerOptions = {
            ...crawlRequestSchema.parse({ url, limit }),
            url: undefined,
            scrapeOptions: undefined,
          };

          const scrapeOptions = scrapeOptionsSchema.parse({
            formats: ["rawHtml"],
            maxAge: 0,
            storeInCache: true,
            onlyMainContent: false,
          });
          const sc: StoredCrawl = {
            originUrl: url,
            crawlerOptions: toV0CrawlerOptions(crawlerOptions),
            scrapeOptions,
            internalOptions: {
              disableSmartWaitCache: true,
              teamId,
              saveScrapeResultToGCS: !!config.GCS_FIRE_ENGINE_BUCKET_NAME,
              zeroDataRetention: false,
              isPreCrawl: true,
            },
            team_id: teamId,
            createdAt: Date.now(),
            maxConcurrency: undefined,
            zeroDataRetention: false,
          };

          await crawlGroup.addGroup(
            crawlId,
            sc.team_id,
            ((await getACUCTeam(sc.team_id))?.flags?.crawlTtlHours ?? 24) *
              60 *
              60 *
              1000,
          );

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
            uuidv7(),
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
  });
}
