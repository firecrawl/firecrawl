import { Request, Response } from "express";
import { checkTeamCredits } from "../../../src/services/billing/credit_billing";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { addScrapeJob } from "../../../src/services/queue-jobs";
import { isUrlBlocked } from "../../../src/scraper/WebScraper/utils/blocklist";
import { validateIdempotencyKey } from "../../../src/services/idempotency/validate";
import { createIdempotencyKey } from "../../../src/services/idempotency/create";
import {
  defaultCrawlPageOptions,
  defaultCrawlerOptions,
  defaultOrigin,
} from "../../../src/lib/default-values";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../../../src/lib/logger";
import {
  addCrawlJob,
  addCrawlJobs,
  crawlToCrawler,
  finishCrawlKickoff,
  lockURL,
  lockURLs,
  markCrawlActive,
  saveCrawl,
  StoredCrawl,
} from "../../../src/lib/crawl-redis";
import { redisEvictConnection } from "../../../src/services/redis";
import { checkAndUpdateURL } from "../../../src/lib/validateUrl";
import * as Sentry from "@sentry/node";
import { getJobPriority } from "../../lib/job-priority";
import { url as urlSchema } from "../v1/types";
import { ZodError } from "zod";
import { BLOCKLISTED_URL_MESSAGE } from "../../lib/strings";
import { fromV0ScrapeOptions } from "../v2/types";
import { isSelfHosted } from "../../lib/deployment";

export async function crawlController(req: Request, res: Response) {
  try {
    const auth = await authenticateUser(req, res, RateLimiterMode.Crawl);
    if (!auth.success) {
      return res.status(auth.status).json({ error: auth.error });
    }

    const { team_id, chunk } = auth;

    if (chunk?.flags?.forceZDR) {
      return res.status(400).json({
        error:
          "Your team has zero data retention enabled. This is not supported on the v0 API. Please update your code to use the v1 API.",
      });
    }

    const id = uuidv4();

    redisEvictConnection.sadd("teams_using_v0", team_id).catch(error =>
      logger.error("Failed to add team to teams_using_v0", {
        error,
        team_id,
      }),
    );

    redisEvictConnection
      .sadd("teams_using_v0:" + team_id, "crawl:" + id)
      .catch(error =>
        logger.error("Failed to add team to teams_using_v0 (2)", {
          error,
          team_id,
        }),
      );

    if (req.headers["x-idempotency-key"]) {
      const isIdempotencyValid = await validateIdempotencyKey(req);
      if (!isIdempotencyValid) {
        return res.status(409).json({ error: "Idempotency key already used" });
      }
      try {
        createIdempotencyKey(req);
      } catch (error) {
        logger.error(error);
        return res.status(500).json({ error: error.message });
      }
    }

    const crawlerOptions = {
      ...defaultCrawlerOptions,
      ...req.body.crawlerOptions,
    };
    const pageOptions = { ...defaultCrawlPageOptions, ...req.body.pageOptions };

    if (Array.isArray(crawlerOptions.includes)) {
      for (const x of crawlerOptions.includes) {
        try {
          new RegExp(x);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
    }

    if (Array.isArray(crawlerOptions.excludes)) {
      for (const x of crawlerOptions.excludes) {
        try {
          new RegExp(x);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
    }

    const limitCheck = req.body?.crawlerOptions?.limit ?? 1;
    const {
      success: creditsCheckSuccess,
      message: creditsCheckMessage,
      remainingCredits,
    } = await checkTeamCredits(chunk, team_id, limitCheck);

    if (!creditsCheckSuccess) {
      return res.status(402).json({
        error: isSelfHosted()
          ? "Insufficient credits. You may be requesting with a higher limit than the amount of credits you have left. Please check your server configuration."
          : "Insufficient credits. You may be requesting with a higher limit than the amount of credits you have left. If not, upgrade your plan at https://firecrawl.dev/pricing or contact us at help@firecrawl.com",
      });
    }

    // TODO: need to do this to v1
    crawlerOptions.limit = Math.min(remainingCredits, crawlerOptions.limit);

    let url = urlSchema.parse(req.body.url);
    if (!url) {
      return res.status(400).json({ error: "Url is required" });
    }
    if (typeof url !== "string") {
      return res.status(400).json({ error: "URL must be a string" });
    }
    try {
      url = checkAndUpdateURL(url).url;
    } catch (e) {
      return res
        .status(e instanceof Error && e.message === "Invalid URL" ? 400 : 500)
        .json({ error: e.message ?? e });
    }

    if (isUrlBlocked(url, auth.chunk?.flags ?? null)) {
      return res.status(403).json({
        error: BLOCKLISTED_URL_MESSAGE,
      });
    }

    // if (mode === "single_urls" && !url.includes(",")) { // NOTE: do we need this?
    //   try {
    //     const a = new WebScraperDataProvider();
    //     await a.setOptions({
    //       jobId: uuidv4(),
    //       mode: "single_urls",
    //       urls: [url],
    //       crawlerOptions: { ...crawlerOptions, returnOnlyUrls: true },
    //       pageOptions: pageOptions,
    //     });

    //     const docs = await a.getDocuments(false, (progress) => {
    //       job.updateProgress({
    //         current: progress.current,
    //         total: progress.total,
    //         current_step: "SCRAPING",
    //         current_url: progress.currentDocumentUrl,
    //       });
    //     });
    //     return res.json({
    //       success: true,
    //       documents: docs,
    //     });
    //   } catch (error) {
    //     logger.error(error);
    //     return res.status(500).json({ error: error.message });
    //   }
    // }

    const { scrapeOptions, internalOptions } = fromV0ScrapeOptions(
      pageOptions,
      undefined,
      undefined,
      team_id,
    );
    internalOptions.disableSmartWaitCache = true; // NOTE: smart wait disabled for crawls to ensure contentful scrape, speed does not matter
    internalOptions.saveScrapeResultToGCS = process.env
      .GCS_FIRE_ENGINE_BUCKET_NAME
      ? true
      : false;
    delete (scrapeOptions as any).timeout;

    const sc: StoredCrawl = {
      originUrl: url,
      crawlerOptions,
      scrapeOptions,
      internalOptions,
      team_id,
      createdAt: Date.now(),
    };

    const crawler = crawlToCrawler(id, sc, auth.chunk?.flags ?? null);

    try {
      sc.robots = await crawler.getRobotsTxt();
    } catch (_) {}

    await saveCrawl(id, sc);

    await markCrawlActive(id);

    await finishCrawlKickoff(id);

    const sitemap = sc.crawlerOptions.ignoreSitemap
      ? 0
      : await crawler.tryGetSitemap(async urls => {
          if (urls.length === 0) return;

          let jobPriority = await getJobPriority({
            team_id,
            basePriority: 21,
          });
          const jobs = urls.map(url => {
            const uuid = uuidv4();
            return {
              jobId: uuid,
              data: {
                url,
                mode: "single_urls" as const,
                crawlerOptions,
                scrapeOptions,
                internalOptions,
                team_id,
                origin: req.body.origin ?? defaultOrigin,
                integration: req.body.integration,
                crawl_id: id,
                sitemapped: true,
                zeroDataRetention: false, // not supported on v0
                apiKeyId: chunk?.api_key_id ?? null,
              },
              priority: jobPriority,
            };
          });

          await lockURLs(
            id,
            sc,
            jobs.map(x => x.data.url),
            logger,
          );
          await addCrawlJobs(
            id,
            jobs.map(x => x.jobId),
            logger,
          );
          for (const job of jobs) {
            // add with sentry instrumentation
            await addScrapeJob(job.data, job.jobId, job.priority);
          }
        });

    if (sitemap === 0) {
      await lockURL(id, sc, url);

      // Not needed, first one should be 15.
      // const jobPriority = await getJobPriority({team_id, basePriority: 10})

      const jobId = uuidv4();
      await addScrapeJob(
        {
          url,
          mode: "single_urls",
          crawlerOptions,
          scrapeOptions,
          internalOptions,
          team_id,
          origin: req.body.origin ?? defaultOrigin,
          integration: req.body.integration,
          crawl_id: id,
          zeroDataRetention: false, // not supported on v0
          apiKeyId: chunk?.api_key_id ?? null,
        },
        jobId,
        await getJobPriority({ team_id, basePriority: 15 }),
      );
      await addCrawlJob(id, jobId, logger);
    }

    res.json({ jobId: id });
  } catch (error) {
    Sentry.captureException(error);
    logger.error(error);
    return res.status(500).json({
      error: error instanceof ZodError ? "Invalid URL" : error.message,
    });
  }
}
